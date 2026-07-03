// Client-side webview script for SF Log Reader. Copied verbatim into out/panel.js at build time.
(function () {
  const vscode = acquireVsCodeApi();

  const orgSelect = document.getElementById('org-select');
  const userSelect = document.getElementById('user-select');
  const refreshOrgsBtn = document.getElementById('refresh-orgs');
  const fetchBtn = document.getElementById('fetch-btn');
  const refreshListBtn = document.getElementById('refresh-list');
  const openFolderBtn = document.getElementById('open-folder');
  const openExternalBtn = document.getElementById('open-external');
  const clearLogsBtn = document.getElementById('clear-logs');
  const externalBanner = document.getElementById('external-banner');
  const externalPathEl = document.getElementById('external-path');
  const externalSummaryBtn = document.getElementById('external-summary');
  const externalKeepBtn = document.getElementById('external-keep');
  const externalCloseBtn = document.getElementById('external-close');
  const statusEl = document.getElementById('status');
  const logListEl = document.getElementById('log-list');
  const selectAllEl = document.getElementById('select-all');
  const selectionCountEl = document.getElementById('selection-count');
  const keepSelectedBtn = document.getElementById('keep-selected');
  const detailHeaderEl = document.getElementById('detail-header');
  const detailBodyEl = document.getElementById('detail-body');
  const detailTabsEl = document.getElementById('detail-tabs');
  const analysisBodyEl = document.getElementById('analysis-body');
  const searchEl = document.getElementById('search');
  const trailEl = document.getElementById('trail');
  const trailHeader = document.getElementById('trail-header');
  const trailBodyEl = document.getElementById('trail-body');
  const trailCountEl = document.getElementById('trail-count');
  const clearTrailBtn = document.getElementById('clear-trail');

  // VS Code tears the webview down whenever the bottom-pane tab is switched away.
  // Persist enough state via vscode.setState/getState that re-show is instant —
  // the selected log + parsed entries re-render before the host responds.
  // Cap how many entries are rendered per pass and persisted — huge logs made
  // every keystroke rebuild (and re-serialize) hundreds of thousands of rows.
  const RENDER_CHUNK = 2000;
  const MAX_PERSIST_ENTRIES = 20000;

  const saved = vscode.getState() || {};
  const state = {
    orgs: [],
    selectedOrg: null,
    users: [],
    selectedUser: null,
    logs: [],
    activeLogId: saved.activeLogId ?? null,
    activeUserId: saved.activeUserId ?? null,
    entries: saved.entries ?? [],
    stats: saved.stats ?? null,
    truncated: saved.truncated ?? false,
    total: saved.total ?? 0,
    filters: new Set(saved.filters ?? ['USER_DEBUG', 'SOQL', 'DML', 'EXCEPTION', 'CALLOUT']),
    search: saved.search ?? '',
    trail: [],
    external: null,
    selected: new Set(),
    fetchRunning: false,
    renderLimit: RENDER_CHUNK,
    activeTab: 'log-tab',
    analysisLoading: false,
    timelineLoading: false
  };

  // Persist the lightweight UI state only (no entries). Called on every keystroke
  // and filter toggle — re-serializing a ≤20k-entry array on each of those was
  // the per-keystroke cost the entries never change there. persistState() (below)
  // writes the entries too, but only when they actually change (body load/select).
  function persistUiState() {
    const prev = vscode.getState() || {};
    vscode.setState({
      ...prev,
      activeLogId: state.activeLogId,
      activeUserId: state.activeUserId,
      filters: Array.from(state.filters),
      search: state.search
    });
  }

  function persistState() {
    vscode.setState({
      activeLogId: state.activeLogId,
      activeUserId: state.activeUserId,
      // Very large logs are not persisted — the host re-sends the body on
      // restore (the 'logs' handler re-requests when entries are empty).
      entries: state.entries.length <= MAX_PERSIST_ENTRIES ? state.entries : [],
      stats: state.stats,
      truncated: state.truncated,
      total: state.total,
      filters: Array.from(state.filters),
      search: state.search
    });
  }

  function post(message) { vscode.postMessage(message); }

  document.querySelectorAll('.filters input[type="checkbox"]').forEach(cb => {
    // Apply restored filter state to checkbox first
    cb.checked = state.filters.has(cb.dataset.cat);
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.add(cb.dataset.cat);
      else state.filters.delete(cb.dataset.cat);
      state.renderLimit = RENDER_CHUNK;
      persistUiState();
      renderEntries();
    });
  });

  if (state.search) searchEl.value = state.search;
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    state.search = searchEl.value.toLowerCase();
    // Debounced: rebuilding the entry DOM and persisting state on every
    // keystroke crawls on big logs.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.renderLimit = RENDER_CHUNK;
      persistUiState();
      renderEntries();
    }, 150);
  });

  orgSelect.addEventListener('change', () => {
    if (orgSelect.value) post({ type: 'selectOrg', username: orgSelect.value });
  });
  refreshOrgsBtn.addEventListener('click', () => post({ type: 'refreshOrgs' }));

  userSelect.addEventListener('change', () => {
    const v = userSelect.value;
    post({ type: 'selectUser', userId: v === '__all__' ? null : v });
  });

  fetchBtn.addEventListener('click', () => post({ type: 'fetchLogs' }));
  refreshListBtn.addEventListener('click', () => post({ type: 'refreshLogs' }));
  openFolderBtn.addEventListener('click', () => post({ type: 'openLogFolder' }));
  openExternalBtn.addEventListener('click', () => post({ type: 'openExternalLog' }));
  clearLogsBtn.addEventListener('click', () => post({ type: 'deleteAllLogs' }));

  selectAllEl.addEventListener('change', () => {
    state.selected = new Set(selectAllEl.checked ? selectableLogs().map(l => l.id) : []);
    renderLogs();
    renderSelection();
  });
  keepSelectedBtn.addEventListener('click', () => {
    const picks = state.logs.filter(l => state.selected.has(l.id)).map(l => ({ logId: l.id, userId: l.userId }));
    if (picks.length === 0) return;
    keepSelectedBtn.disabled = true;
    keepSelectedBtn.textContent = 'Saving…';
    post({ type: 'keepLogs', logs: picks });
    setTimeout(() => {
      keepSelectedBtn.innerHTML = '\u{1F4BE} Keep selected';
      renderSelection();
    }, 2000);
  });
  externalCloseBtn.addEventListener('click', () => post({ type: 'closeExternalLog' }));
  externalKeepBtn.addEventListener('click', () => {
    externalKeepBtn.disabled = true;
    externalKeepBtn.textContent = 'Saving…';
    post({ type: 'keepExternalLog' });
    setTimeout(() => {
      externalKeepBtn.disabled = false;
      externalKeepBtn.innerHTML = '\u{1F4BE} Keep';
    }, 2000);
  });
  externalSummaryBtn.addEventListener('click', () => {
    externalSummaryBtn.disabled = true;
    externalSummaryBtn.textContent = 'Generating…';
    post({ type: 'generateExternalSummary' });
    setTimeout(() => {
      externalSummaryBtn.disabled = false;
      externalSummaryBtn.textContent = 'Summary';
    }, 2000);
  });

  trailHeader.addEventListener('click', e => {
    if (e.target === clearTrailBtn) return;
    trailEl.classList.toggle('collapsed');
  });
  clearTrailBtn.addEventListener('click', e => {
    e.stopPropagation();
    post({ type: 'clearCommandTrail' });
  });

  detailTabsEl.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    activateTab(btn.dataset.tab);
  });

  function activateTab(tabId) {
    state.activeTab = tabId;
    detailTabsEl.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === tabId);
    });
    if (tabId === 'analysis-tab') requestAnalysisIfNeeded();
    if (tabId === 'timeline-tab') requestTimelineIfNeeded();
  }

  // Identify the currently selected log the same way the rest of the webview
  // does: internal logs by (logId, userId) against the local store, external
  // logs by source path (there is no Id for a file opened from disk).
  function currentLogRef() {
    if (state.external) return { logId: state.external.sourcePath, external: true };
    if (state.activeLogId) return { logId: state.activeLogId, userId: state.activeUserId, external: false };
    return null;
  }

  function requestAnalysisIfNeeded() {
    const ref = currentLogRef();
    if (!ref) {
      state.analysisLoading = false;
      renderAnalysisEmpty('No log selected.');
      return;
    }
    // Avoid recomputing on every tab re-activation for the same log — only
    // (re)request when the selection changed since the last successful/errored render.
    if (state.analysisFor === ref.logId && !state.analysisLoading) return;
    state.analysisLoading = true;
    state.analysisFor = ref.logId;
    renderAnalysisEmpty('Analyzing…');
    post({ type: 'requestAnalysis', logId: ref.logId, userId: ref.userId, external: ref.external });
  }

  function renderAnalysisEmpty(text) {
    analysisBodyEl.innerHTML = '';
    const em = document.createElement('div');
    em.className = 'empty';
    em.textContent = text;
    analysisBodyEl.appendChild(em);
  }

  function requestTimelineIfNeeded() {
    const ref = currentLogRef();
    if (!ref) {
      state.timelineLoading = false;
      state.timelineFor = null;
      timeline.showEmpty('No log selected.');
      return;
    }
    // Newly (re)shown while already loaded for this log — the canvas may have
    // been sized while hidden (0 px); re-measure and repaint.
    if (state.timelineFor === ref.logId && !state.timelineLoading) {
      timeline.resize();
      return;
    }
    state.timelineLoading = true;
    state.timelineFor = ref.logId;
    timeline.showEmpty('Building timeline…');
    post({ type: 'requestTimeline', logId: ref.logId, userId: ref.userId, external: ref.external });
  }

  function selectableLogs() {
    return state.logs.filter(l => !l.pending && !l.failed);
  }

  function updateFetchButton() {
    fetchBtn.disabled = state.orgs.length === 0 || state.fetchRunning;
    fetchBtn.textContent = state.fetchRunning ? '⬇ Fetching…' : '⬇ Fetch';
  }

  function renderOrgs() {
    orgSelect.innerHTML = '';
    updateFetchButton();
    if (state.orgs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No authenticated orgs';
      orgSelect.appendChild(opt);
      orgSelect.disabled = true;
      return;
    }
    orgSelect.disabled = false;
    for (const org of state.orgs) {
      const opt = document.createElement('option');
      opt.value = org.username;
      opt.textContent = org.label;
      if (org.username === state.selectedOrg) opt.selected = true;
      orgSelect.appendChild(opt);
    }
  }

  function renderUsers() {
    userSelect.innerHTML = '';
    const all = document.createElement('option');
    all.value = '__all__';
    all.textContent = 'All users';
    if (!state.selectedUser) all.selected = true;
    userSelect.appendChild(all);
    for (const u of state.users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name + (u.source === 'log' ? ' (from log)' : '');
      if (u.id === state.selectedUser) opt.selected = true;
      userSelect.appendChild(opt);
    }
  }

  function renderLogs() {
    logListEl.innerHTML = '';
    if (state.logs.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.textContent = 'No locally stored logs. Pick an org + user, then click Fetch.';
      logListEl.appendChild(em);
      return;
    }
    for (const log of state.logs) {
      const row = document.createElement('div');
      row.className = 'log-row' + (log.id === state.activeLogId ? ' active' : '');
      if (log.pending) row.classList.add('pending');
      if (log.failed) row.classList.add('failed');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'row-check';
      check.checked = state.selected.has(log.id);
      check.disabled = !!(log.pending || log.failed);
      check.addEventListener('click', e => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) state.selected.add(log.id);
        else state.selected.delete(log.id);
        renderSelection();
      });
      row.appendChild(check);

      const body = document.createElement('div');
      body.className = 'row-body';
      row.appendChild(body);

      row.addEventListener('click', () => {
        state.activeLogId = log.id;
        state.activeUserId = log.userId;
        state.entries = [];
        state.stats = null;
        state.truncated = false;
        state.total = 0;
        state.renderLimit = RENDER_CHUNK;
        state.analysisFor = null;
        state.timelineFor = null;
        persistState();
        if (state.external) {
          state.external = null;
          externalBanner.classList.remove('visible');
        }
        renderLogs();
        renderDetailHeader(null);
        if (log.pending) {
          // Body still downloading — ask the host to bump it to the front of
          // the queue; the logPatch handler requests it once it lands.
          detailHeaderEl.innerHTML = '<span class="empty">Downloading…</span>';
          detailBodyEl.innerHTML = '<div class="empty">Downloading log…</div>';
          post({ type: 'prioritizeLog', logId: log.id });
        } else if (log.failed) {
          detailBodyEl.innerHTML = '<div class="empty">Download failed — run Fetch again to retry.</div>';
        } else {
          detailBodyEl.innerHTML = '<div class="empty">Loading…</div>';
          post({ type: 'selectLog', logId: log.id, userId: log.userId });
        }
        if (state.activeTab === 'analysis-tab') requestAnalysisIfNeeded();
        if (state.activeTab === 'timeline-tab') requestTimelineIfNeeded();
      });
      row.addEventListener('dblclick', () => {
        if (log.pending || log.failed) return;
        post({ type: 'openLogInEditor', logId: log.id, userId: log.userId });
      });

      const top = document.createElement('div');
      top.className = 'row-top';
      const user = document.createElement('span');
      user.className = 'row-user';
      user.textContent = (log.hasSummary ? '¶ ' : '') + (log.userName || log.userId || 'unknown');
      if (log.hasSummary) user.title = 'Summary available';
      const time = document.createElement('span');
      time.className = 'row-time';
      time.textContent = formatTime(log.startTime);
      top.appendChild(user);
      top.appendChild(time);

      const bot = document.createElement('div');
      bot.className = 'row-bot';
      if (log.pending) {
        const badge = document.createElement('span');
        badge.className = 'row-pending';
        badge.textContent = '⏳ downloading…';
        bot.appendChild(badge);
      } else if (log.failed) {
        const badge = document.createElement('span');
        badge.className = 'row-failed';
        badge.textContent = '⚠ download failed';
        bot.appendChild(badge);
      }
      const op = document.createElement('span');
      op.textContent = (log.operation || '').slice(0, 32);
      const status = document.createElement('span');
      const ok = (log.status || '').toLowerCase().startsWith('success');
      status.className = ok ? 'row-status-success' : (log.status ? 'row-status-failed' : '');
      status.textContent = log.status || '';
      const size = document.createElement('span');
      size.textContent = log.logLength ? formatBytes(log.logLength) : '';
      const dur = document.createElement('span');
      dur.textContent = log.durationMs != null ? `${log.durationMs} ms` : '';
      bot.appendChild(op);
      if (status.textContent) bot.appendChild(status);
      if (size.textContent) bot.appendChild(size);
      if (dur.textContent) bot.appendChild(dur);

      body.appendChild(top);
      body.appendChild(bot);
      logListEl.appendChild(row);
    }
    renderSelection();
  }

  function renderSelection() {
    const n = state.selected.size;
    selectionCountEl.textContent = `${n} selected`;
    keepSelectedBtn.disabled = n === 0;
    if (keepSelectedBtn.textContent === 'Saving…' && n === 0) {
      keepSelectedBtn.innerHTML = '\u{1F4BE} Keep selected';
    }
    const selectable = selectableLogs();
    if (selectable.length > 0) {
      const allSelected = selectable.every(l => state.selected.has(l.id));
      selectAllEl.checked = allSelected;
      selectAllEl.indeterminate = !allSelected && n > 0;
    } else {
      selectAllEl.checked = false;
      selectAllEl.indeterminate = false;
    }
  }

  function renderDetailHeader(stats, logId, isExternal) {
    if (!stats) {
      detailHeaderEl.innerHTML = '<span class="empty">No log selected.</span>';
      return;
    }
    detailHeaderEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'stats';
    wrap.appendChild(makeStat('Total', stats.total));
    for (const [cat, count] of Object.entries(stats.byCategory)) {
      if (count > 0) wrap.appendChild(makeStat(cat, count));
    }
    detailHeaderEl.appendChild(wrap);
    if (!isExternal) {
      const keepBtn = document.createElement('button');
      keepBtn.innerHTML = '\u{1F4BE} Keep';
      keepBtn.title = 'Copy this log into the saved-logs folder';
      keepBtn.addEventListener('click', () => {
        keepBtn.disabled = true;
        keepBtn.textContent = 'Saving…';
        post({ type: 'keepLog', logId, userId: state.activeUserId });
        setTimeout(() => {
          keepBtn.disabled = false;
          keepBtn.innerHTML = '\u{1F4BE} Keep';
        }, 2000);
      });
      detailHeaderEl.appendChild(keepBtn);
      const summaryBtn = document.createElement('button');
      summaryBtn.textContent = 'Generate summary';
      summaryBtn.title = 'Write a Markdown + Mermaid summary next to this log';
      summaryBtn.addEventListener('click', () => {
        summaryBtn.disabled = true;
        summaryBtn.textContent = 'Generating…';
        post({ type: 'generateSummary', logId, userId: state.activeUserId });
      });
      detailHeaderEl.appendChild(summaryBtn);
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open file';
      openBtn.title = 'Open the .log file in an editor tab';
      openBtn.addEventListener('click', () => {
        post({ type: 'openLogInEditor', logId, userId: state.activeUserId });
      });
      detailHeaderEl.appendChild(openBtn);
    }
  }

  function makeStat(label, value) {
    const el = document.createElement('span');
    el.className = 'stat';
    el.innerHTML = `<strong>${value}</strong> ${escapeHtml(label)}`;
    return el;
  }

  function renderEntries() {
    detailBodyEl.innerHTML = '';
    if (state.entries.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.textContent = state.activeLogId ? 'No matching entries.' : 'Pick a log on the left.';
      detailBodyEl.appendChild(em);
      return;
    }
    const search = state.search;
    const frag = document.createDocumentFragment();
    let shown = 0;
    let matched = 0;
    for (const e of state.entries) {
      if (!state.filters.has(e.category)) continue;
      if (search && !e.message.toLowerCase().includes(search) && !e.eventType.toLowerCase().includes(search)) continue;
      matched += 1;
      // Past the render cap: keep counting matches for the button label only.
      if (shown >= state.renderLimit) continue;
      const row = document.createElement('div');
      row.className = `log-entry cat-${e.category}`;
      if (e.lineNumber != null) row.dataset.line = e.lineNumber;
      if (search) row.classList.add('search-hit');

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = e.timestamp;
      const type = document.createElement('span');
      type.className = 'type';
      type.textContent = e.eventType;
      const lineref = document.createElement('span');
      lineref.className = 'lineref';
      lineref.textContent = e.lineRef || '';
      const filler = document.createElement('span');

      row.appendChild(time);
      row.appendChild(type);
      row.appendChild(lineref);
      row.appendChild(filler);

      if (e.message) {
        const msg = document.createElement('div');
        msg.className = 'msg';
        msg.textContent = e.message;
        row.appendChild(msg);
      }
      frag.appendChild(row);
      shown += 1;
    }
    detailBodyEl.appendChild(frag);
    if (shown === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.textContent = 'All entries filtered out.';
      detailBodyEl.appendChild(em);
      return;
    }
    if (matched > shown) {
      const more = document.createElement('button');
      more.className = 'show-more';
      more.textContent = `Show ${Math.min(RENDER_CHUNK, matched - shown)} more (${matched - shown} hidden)`;
      more.addEventListener('click', () => {
        state.renderLimit += RENDER_CHUNK;
        renderEntries();
      });
      detailBodyEl.appendChild(more);
    }
    // The host caps how many parsed entries cross the bridge (HOST_ENTRY_CAP).
    // When it did, tell the user and offer the full .log in an editor tab — the
    // in-panel view can never show past the cap no matter how far they scroll.
    if (state.truncated) {
      const note = document.createElement('div');
      note.className = 'empty';
      const shownCount = state.entries.length;
      const totalCount = state.total || shownCount;
      note.textContent = `Showing the first ${shownCount.toLocaleString()} of ${totalCount.toLocaleString()} parsed entries. `;
      if (!state.external && state.activeLogId) {
        const link = document.createElement('button');
        link.className = 'show-more';
        link.textContent = 'Open the full log in an editor';
        link.addEventListener('click', () => {
          post({ type: 'openLogInEditor', logId: state.activeLogId, userId: state.activeUserId });
        });
        note.appendChild(link);
      } else {
        note.textContent += 'Open the source .log file for the full log.';
      }
      detailBodyEl.appendChild(note);
    }
  }

  // Timeline click-to-jump: switch to the Log tab and scroll the entry list to
  // the span's source line, briefly highlighting it. The host caps how many
  // entries cross the bridge, so the exact line may not be rendered — fall back
  // to the nearest rendered entry by lineNumber (closest data-line ≤ target,
  // else the first one after it).
  function jumpToLine(lineNumber) {
    activateTab('log-tab');
    const rows = detailBodyEl.querySelectorAll('.log-entry[data-line]');
    if (rows.length === 0) return;
    let best = null;
    let bestDelta = Infinity;
    for (const row of rows) {
      const ln = Number(row.dataset.line);
      const delta = Math.abs(ln - lineNumber);
      if (delta < bestDelta) { bestDelta = delta; best = row; }
      if (delta === 0) break;
    }
    if (!best) return;
    best.scrollIntoView({ block: 'center' });
    best.classList.add('entry-flash');
    setTimeout(() => best.classList.remove('entry-flash'), 1200);
  }

  const OBSERVED_LABELS = [
    ['soqlQueries', 'SOQL queries'],
    ['soqlRows', 'SOQL rows'],
    ['soslQueries', 'SOSL queries'],
    ['dmlStatements', 'DML statements'],
    ['dmlRows', 'DML rows'],
    ['callouts', 'Callouts'],
    ['asyncJobsEnqueued', 'Async jobs enqueued'],
    ['publishImmediateEvents', 'Publish-immediate events']
  ];

  // Renders the Analysis tab. All values originate from parsed (untrusted) log
  // content, so every node is built with createElement/textContent — never
  // innerHTML — exactly like renderEntries() does for the Log tab.
  function renderAnalysis(payload) {
    analysisBodyEl.innerHTML = '';
    if (!payload) {
      renderAnalysisEmpty('No analysis available.');
      return;
    }
    const frag = document.createDocumentFragment();

    const header = document.createElement('div');
    header.className = 'analysis-header-line';
    header.textContent = payload.totalElapsedMs != null
      ? `Total elapsed: ${payload.totalElapsedMs.toFixed(1)} ms`
      : 'Total elapsed: n/a';
    frag.appendChild(header);

    if (payload.limitExceptions && payload.limitExceptions.length > 0) {
      frag.appendChild(buildLimitExceptionsSection(payload.limitExceptions));
    }
    frag.appendChild(buildLimitsSection(payload.limits || []));
    frag.appendChild(buildObservedSection(payload.observed));
    frag.appendChild(buildDmlSection(payload.dmlBreakdown || []));
    frag.appendChild(buildSoqlSection(payload.soqlTimings || []));
    frag.appendChild(buildHottestMethodsSection(payload.hottestMethods || []));
    frag.appendChild(buildClassStatsSection(payload.classStats || []));

    analysisBodyEl.appendChild(frag);
  }

  function makeSection(title) {
    const section = document.createElement('div');
    section.className = 'analysis-section';
    const h = document.createElement('h3');
    h.textContent = title;
    section.appendChild(h);
    return section;
  }

  function sectionEmpty(text) {
    const em = document.createElement('div');
    em.className = 'section-empty';
    em.textContent = text;
    return em;
  }

  function buildLimitExceptionsSection(exceptions) {
    const section = makeSection('Limit exceptions');
    for (const exc of exceptions) {
      const row = document.createElement('div');
      row.className = 'limit-exception-row';
      const msg = document.createElement('div');
      msg.className = 'exc-message';
      msg.textContent = exc.message;
      row.appendChild(msg);
      const metaParts = [];
      if (exc.value != null && exc.cap != null) metaParts.push(`${exc.value} / ${exc.cap}`);
      else if (exc.value != null) metaParts.push(String(exc.value));
      if (exc.metric) metaParts.push(exc.metric);
      if (exc.lineRef) metaParts.push(exc.lineRef);
      if (metaParts.length > 0) {
        const meta = document.createElement('div');
        meta.className = 'exc-meta';
        meta.textContent = metaParts.join(' — ');
        row.appendChild(meta);
      }
      section.appendChild(row);
    }
    return section;
  }

  function buildLimitsSection(limits) {
    const section = makeSection('Governor limits');
    const usable = limits.filter(l => l.max > 0);
    if (usable.length === 0) {
      section.appendChild(sectionEmpty('No governor limit data in this log.'));
      return section;
    }
    for (const limit of usable) {
      const pct = Math.max(0, Math.min(1, limit.used / limit.max));
      const row = document.createElement('div');
      row.className = 'limit-row';

      const name = document.createElement('span');
      name.className = 'limit-name';
      name.textContent = limit.name;
      name.title = limit.name;

      const used = document.createElement('span');
      used.className = 'limit-used';
      used.textContent = `${limit.used} / ${limit.max}`;

      const track = document.createElement('span');
      track.className = 'limit-bar-track';
      const fill = document.createElement('span');
      fill.className = 'limit-bar-fill';
      if (pct >= 0.9) fill.classList.add('error');
      else if (pct >= 0.75) fill.classList.add('warn');
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      track.appendChild(fill);

      row.appendChild(name);
      row.appendChild(used);
      row.appendChild(track);
      section.appendChild(row);
    }
    return section;
  }

  function buildObservedSection(observed) {
    const section = makeSection('Observed counts');
    if (!observed) {
      section.appendChild(sectionEmpty('No data.'));
      return section;
    }
    const table = document.createElement('table');
    table.className = 'analysis-table two-col';
    const tbody = document.createElement('tbody');
    for (const [key, label] of OBSERVED_LABELS) {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = label;
      const td = document.createElement('td');
      td.textContent = String(observed[key] ?? 0);
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function buildDmlSection(rows) {
    const section = makeSection('DML breakdown');
    if (rows.length === 0) {
      section.appendChild(sectionEmpty('No DML statements recorded.'));
      return section;
    }
    const table = document.createElement('table');
    table.className = 'analysis-table';
    table.appendChild(makeHeaderRow(['Op', 'Type', 'Count', 'Rows']));
    const tbody = document.createElement('tbody');
    for (const d of rows) {
      tbody.appendChild(makeRow([d.op, d.type, String(d.count), String(d.rows)]));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function buildSoqlSection(rows) {
    const section = makeSection('SOQL queries');
    if (rows.length === 0) {
      section.appendChild(sectionEmpty('No SOQL queries recorded.'));
      return section;
    }
    const table = document.createElement('table');
    table.className = 'analysis-table';
    table.appendChild(makeHeaderRow(['Query', 'Rows', 'Duration (ms)', 'Line']));
    const tbody = document.createElement('tbody');
    for (const q of rows) {
      const tr = document.createElement('tr');
      const queryTd = document.createElement('td');
      const full = q.query || '';
      queryTd.textContent = full.length > 150 ? `${full.slice(0, 150)}…` : full;
      queryTd.title = full;
      tr.appendChild(queryTd);
      tr.appendChild(makeCell(q.rows != null ? String(q.rows) : ''));
      tr.appendChild(makeCell(q.durationMs != null ? q.durationMs.toFixed(1) : ''));
      tr.appendChild(makeCell(q.lineRef || ''));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function buildHottestMethodsSection(rows) {
    const section = makeSection('Hottest methods');
    if (rows.length === 0) {
      section.appendChild(sectionEmpty('No method entries recorded.'));
      return section;
    }
    const table = document.createElement('table');
    table.className = 'analysis-table';
    table.appendChild(makeHeaderRow(['Signature', 'Entries']));
    const tbody = document.createElement('tbody');
    for (const m of rows) {
      tbody.appendChild(makeRow([m.signature, String(m.enters)]));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function buildClassStatsSection(rows) {
    const section = makeSection('Classes / triggers');
    if (rows.length === 0) {
      section.appendChild(sectionEmpty('No class/trigger activity recorded.'));
      return section;
    }
    const table = document.createElement('table');
    table.className = 'analysis-table';
    // Σ of inclusive frame times — nested/recursive re-entries of the same
    // class double-count, so this can legitimately exceed wall-clock time.
    table.appendChild(makeHeaderRow(['Name', 'SOQL', 'DML', 'Callouts', 'Exceptions', 'Enters', 'Σ ms (incl. nested)']));
    const tbody = document.createElement('tbody');
    for (const c of rows) {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.textContent = c.isTrigger ? `${c.className} (trigger)` : c.className;
      tr.appendChild(nameTd);
      tr.appendChild(makeCell(String(c.soql)));
      tr.appendChild(makeCell(String(c.dml)));
      tr.appendChild(makeCell(String(c.callouts)));
      tr.appendChild(makeCell(String(c.exceptions)));
      tr.appendChild(makeCell(String(c.enters)));
      tr.appendChild(makeCell((c.totalNanos / 1e6).toFixed(1)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function makeHeaderRow(labels) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const label of labels) {
      const th = document.createElement('th');
      th.textContent = label;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function makeCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function makeRow(cells) {
    const tr = document.createElement('tr');
    for (const text of cells) tr.appendChild(makeCell(text));
    return tr;
  }

  function renderTrail() {
    trailCountEl.textContent = `(${state.trail.length})`;
    trailBodyEl.innerHTML = '';
    if (state.trail.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.textContent = 'No commands recorded yet.';
      trailBodyEl.appendChild(em);
      return;
    }
    for (const entry of state.trail.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'trail-row';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = new Date(entry.startedAt).toLocaleTimeString();
      const stat = document.createElement('span');
      stat.className = entry.ok ? 'status-ok' : 'status-err';
      stat.textContent = entry.ok ? 'OK' : `EXIT ${entry.exitCode}`;
      const cmd = document.createElement('span');
      cmd.className = 'cmd';
      cmd.textContent = `${entry.cmd} ${entry.args.join(' ')}`;
      const dur = document.createElement('span');
      dur.className = 'duration';
      dur.textContent = `${entry.durationMs} ms`;
      row.appendChild(when);
      row.appendChild(stat);
      row.appendChild(cmd);
      row.appendChild(dur);
      if (entry.note) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = entry.note;
        row.appendChild(note);
      }
      if (!entry.ok && entry.stderrSnippet) {
        const errEl = document.createElement('div');
        errEl.className = 'stderr';
        errEl.textContent = entry.stderrSnippet;
        row.appendChild(errEl);
      }
      trailBodyEl.appendChild(row);
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- Timeline flame chart -------------------------------------------------
  // Single closure holding the loaded spans + current view window. All layout
  // math is done in CSS pixels; devicePixelRatio is applied once per render via
  // setTransform so 1 unit === 1 CSS px everywhere below. The canvas is a fixed
  // viewport the size of .timeline-body; rows scroll vertically under a fixed
  // top ruler via scrollY (keeps the time<->x zoom math independent of scroll).
  const timeline = (function () {
    const canvas = document.getElementById('timeline-canvas');
    const bodyEl = document.getElementById('timeline-body');
    const headerEl = document.getElementById('timeline-header');
    const tooltipEl = document.getElementById('timeline-tooltip');
    const ctx = canvas.getContext('2d');

    const RULER_H = 20;   // top time-ruler strip (CSS px)
    const ROW_H = 18;     // per-depth row height (CSS px)
    const MIN_NANOS_PER_PX = 1000; // max zoom: 1 µs per px

    const view = {
      spans: [],
      spansByDepth: [],   // spans[] grouped by depth, each sorted by startNanos
      totalNanos: 0,
      spanCapHit: false,
      maxDepth: 0,
      viewStart: 0,       // nanos at x=0
      viewEnd: 0,         // nanos at x=width
      scrollY: 0,
      width: 0,           // CSS px
      height: 0,          // CSS px
      empty: 'No log selected.'
    };

    // Category colors, read from the same CSS vars (with the same fallbacks) the
    // .cat-* stylesheet rules use, so the flame chart tracks the active theme.
    const COLOR_VARS = {
      CODE_UNIT: ['--vscode-charts-blue', '#3794ff'],
      METHOD: ['--vscode-descriptionForeground', '#8b8b8b'],
      SOQL: ['--vscode-editorWarning-foreground', '#d29922'],
      DML: ['--vscode-charts-purple', '#9d4edd'],
      CALLOUT: ['--vscode-charts-green', '#2ea043']
    };
    let colorCache = null;
    function colorFor(kind) {
      if (!colorCache) {
        colorCache = {};
        const cs = getComputedStyle(document.body);
        for (const [kind2, [varName, fallback]] of Object.entries(COLOR_VARS)) {
          const v = cs.getPropertyValue(varName).trim();
          colorCache[kind2] = v || fallback;
        }
      }
      return colorCache[kind] || '#888888';
    }
    function cssVar(name, fallback) {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    }

    function fullSpan() {
      // Never let the window collapse to zero (a log with a single instant span).
      return Math.max(view.totalNanos, 1);
    }

    function spanNanos() { return view.viewEnd - view.viewStart; }
    function timeToX(t) { return (t - view.viewStart) / spanNanos() * view.width; }
    function xToTime(x) { return view.viewStart + (x / view.width) * spanNanos(); }

    function clampView() {
      const full = fullSpan();
      let span = view.viewEnd - view.viewStart;
      // Clamp zoom range: [MIN_NANOS_PER_PX * width, full].
      const minSpan = Math.min(full, MIN_NANOS_PER_PX * Math.max(view.width, 1));
      if (span > full) span = full;
      if (span < minSpan) span = minSpan;
      // Clamp position so the window stays within [0, full].
      let start = view.viewStart;
      if (start < 0) start = 0;
      if (start + span > full) start = full - span;
      if (start < 0) start = 0;
      view.viewStart = start;
      view.viewEnd = start + span;
    }

    function maxScrollY() {
      const contentH = (view.maxDepth + 1) * ROW_H;
      const viewportH = Math.max(0, view.height - RULER_H);
      return Math.max(0, contentH - viewportH);
    }
    function clampScroll() {
      if (view.scrollY < 0) view.scrollY = 0;
      const m = maxScrollY();
      if (view.scrollY > m) view.scrollY = m;
    }

    // Measure the CSS box, resize the backing store for the current DPR, and
    // repaint. Called on load, on ResizeObserver ticks, and on re-show (the
    // canvas may have been laid out while the tab was hidden = 0 px).
    function resize() {
      if (!bodyEl) return;
      const cssW = Math.max(0, Math.floor(bodyEl.clientWidth));
      const cssH = Math.max(0, Math.floor(bodyEl.clientHeight));
      view.width = cssW;
      view.height = cssH;
      if (cssW === 0 || cssH === 0) return; // hidden — nothing to paint yet
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = cssH + 'px';
      clampView();
      clampScroll();
      render();
    }

    function load(spans, totalNanos, spanCapHit) {
      if (!spans || spans.length === 0) {
        showEmpty('No spans in this log — nothing to chart. Capture with method-level detail (Profiling/FINEST) for a timeline.');
        return;
      }
      view.spans = spans;
      view.totalNanos = totalNanos;
      view.spanCapHit = spanCapHit;
      view.scrollY = 0;
      view.maxDepth = 0;
      const byDepth = [];
      for (const s of spans) {
        if (s.depth > view.maxDepth) view.maxDepth = s.depth;
        (byDepth[s.depth] || (byDepth[s.depth] = [])).push(s);
      }
      // Spans arrive in DFS/open order, so each depth bucket is already sorted by
      // startNanos — hit-testing binary-searches on that.
      view.spansByDepth = byDepth;
      // Initial window = whole log.
      view.viewStart = 0;
      view.viewEnd = fullSpan();
      hideTooltip();
      renderHeader();
      resize();
    }

    function showEmpty(text) {
      view.spans = [];
      view.spansByDepth = [];
      view.empty = text;
      hideTooltip();
      renderHeader();
      // Clear the canvas so a stale chart doesn't linger behind the message.
      if (view.width && view.height) {
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, view.width, view.height);
      }
      renderEmptyOverlay(text);
    }

    function showError(message) {
      showEmpty(`Could not build timeline: ${message}`);
    }

    let emptyEl = null;
    function renderEmptyOverlay(text) {
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'empty';
        bodyEl.appendChild(emptyEl);
      }
      emptyEl.textContent = text;
      emptyEl.style.display = view.spans.length === 0 ? '' : 'none';
    }
    function clearEmptyOverlay() {
      if (emptyEl) emptyEl.style.display = 'none';
    }

    function renderHeader() {
      headerEl.innerHTML = '';
      if (view.spans.length === 0) {
        const em = document.createElement('span');
        em.className = 'empty';
        em.textContent = state.timelineLoading ? 'Building timeline…' : view.empty;
        headerEl.appendChild(em);
        return;
      }
      const dur = document.createElement('span');
      dur.className = 'tl-stat';
      dur.innerHTML = `<strong>${(view.totalNanos / 1e6).toFixed(2)}</strong> ms total`;
      headerEl.appendChild(dur);

      const count = document.createElement('span');
      count.className = 'tl-stat';
      count.innerHTML = `<strong>${view.spans.length.toLocaleString()}</strong> spans`;
      headerEl.appendChild(count);

      const hasMethod = view.spans.some(s => s.kind === 'METHOD');
      if (!hasMethod) {
        const hint = document.createElement('span');
        hint.className = 'tl-hint';
        hint.textContent = 'No method-level detail — capture with the Profiling (FINEST) preset to see method spans.';
        headerEl.appendChild(hint);
      }
      if (view.spanCapHit) {
        const warn = document.createElement('span');
        warn.className = 'tl-warn';
        warn.textContent = 'span cap hit — timeline truncated';
        headerEl.appendChild(warn);
      }
      const reset = document.createElement('button');
      reset.textContent = 'Reset zoom';
      reset.addEventListener('click', () => {
        view.viewStart = 0;
        view.viewEnd = fullSpan();
        view.scrollY = 0;
        hideTooltip();
        render();
      });
      headerEl.appendChild(reset);
    }

    function render() {
      if (!view.width || !view.height) return;
      clearEmptyOverlay();
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
      if (view.spans.length === 0) return;

      drawSpans();
      drawRuler(); // ruler last so rows never paint over it

      // Keep the tooltip's content in sync if it's showing for a span that moved.
      if (hoverSpan) positionTooltipFor(hoverSpan, lastMouse.x, lastMouse.y);
    }

    function drawSpans() {
      const w = view.width;
      const bottom = view.height;
      // Hoist theme reads out of the per-span hot loop (getComputedStyle is slow).
      const activityColor = cssVar('--vscode-descriptionForeground', '#8b8b8b');
      const editorBg = cssVar('--vscode-editor-background', '#1e1e1e');
      ctx.textBaseline = 'middle';
      ctx.font = '10px var(--vscode-font-family, sans-serif)';

      for (let d = 0; d < view.spansByDepth.length; d++) {
        const bucket = view.spansByDepth[d];
        if (!bucket) continue;
        const y = RULER_H + d * ROW_H - view.scrollY;
        // Vertical cull: whole row off-screen.
        if (y + ROW_H <= RULER_H || y >= bottom) continue;

        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          if (s.endNanos < view.viewStart || s.startNanos > view.viewEnd) continue; // time cull
          let x0 = timeToX(s.startNanos);
          let x1 = timeToX(s.endNanos);
          if (x1 < 0 || x0 > w) continue;
          const screenW = x1 - x0;

          if (screenW < 0.5) {
            // Sub-pixel: 1-px activity tick, no fill/text.
            ctx.fillStyle = activityColor;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(Math.max(0, x0), y + 1, 1, ROW_H - 2);
            ctx.globalAlpha = 1;
            continue;
          }

          const cx0 = Math.max(0, x0);
          const cx1 = Math.min(w, x1);
          const drawW = cx1 - cx0;
          ctx.fillStyle = colorFor(s.kind);
          ctx.fillRect(cx0, y + 1, drawW, ROW_H - 2);

          if (s.truncated) {
            // Dashed right edge signals a frame that never closed (log cut off).
            ctx.save();
            ctx.strokeStyle = editorBg;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(Math.min(w - 0.5, x1) - 0.5, y + 1);
            ctx.lineTo(Math.min(w - 0.5, x1) - 0.5, y + ROW_H - 1);
            ctx.stroke();
            ctx.restore();
          }

          if (drawW >= 30) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(cx0 + 2, y, drawW - 4, ROW_H);
            ctx.clip();
            ctx.fillStyle = editorBg;
            ctx.fillText(fitText(s.label, drawW - 6), cx0 + 3, y + ROW_H / 2 + 1);
            ctx.restore();
          }
        }
      }
    }

    // Cheap width-based ellipsis — avoids per-char measureText in the hot path.
    function fitText(text, px) {
      const maxChars = Math.floor(px / 6); // ~6 px per char at 10px monospace-ish
      if (maxChars <= 0) return '';
      if (text.length <= maxChars) return text;
      if (maxChars <= 1) return '…';
      return text.slice(0, maxChars - 1) + '…';
    }

    function drawRuler() {
      const w = view.width;
      const bg = cssVar('--vscode-panel-background', '#252526');
      const fg = cssVar('--vscode-descriptionForeground', '#8b8b8b');
      const border = cssVar('--vscode-panel-border', '#3c3c3c');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, RULER_H);
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, RULER_H - 0.5);
      ctx.lineTo(w, RULER_H - 0.5);
      ctx.stroke();

      // Pick a round ms step giving ~80 px between ticks at the current zoom.
      const spanMs = spanNanos() / 1e6;
      const targetTicks = Math.max(2, Math.floor(w / 80));
      const rawStep = spanMs / targetTicks;
      const step = niceStep(rawStep); // in ms
      const startMs = view.viewStart / 1e6;
      const endMs = view.viewEnd / 1e6;
      const first = Math.ceil(startMs / step) * step;
      ctx.fillStyle = fg;
      ctx.strokeStyle = border;
      ctx.textBaseline = 'alphabetic';
      ctx.font = '10px var(--vscode-font-family, sans-serif)';
      for (let ms = first; ms <= endMs; ms += step) {
        const x = timeToX(ms * 1e6);
        if (x < 0 || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H - 5);
        ctx.lineTo(Math.round(x) + 0.5, RULER_H);
        ctx.stroke();
        ctx.fillText(formatMsLabel(ms, step), Math.round(x) + 3, RULER_H - 7);
      }
    }

    function niceStep(raw) {
      if (raw <= 0) return 1;
      const pow = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / pow;
      let mult;
      if (norm <= 1) mult = 1;
      else if (norm <= 2) mult = 2;
      else if (norm <= 5) mult = 5;
      else mult = 10;
      return mult * pow;
    }

    function formatMsLabel(ms, step) {
      const decimals = step >= 1 ? 0 : (step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
      return `${ms.toFixed(decimals)} ms`;
    }

    // ---- hit testing + tooltip ----
    let hoverSpan = null;
    const lastMouse = { x: 0, y: 0 };

    function spanAt(px, py) {
      if (py < RULER_H) return null;
      const d = Math.floor((py - RULER_H + view.scrollY) / ROW_H);
      const bucket = view.spansByDepth[d];
      if (!bucket) return null;
      const t = xToTime(px);
      // Binary search for the last span whose startNanos <= t, then walk back a
      // few in case of adjacent zero-width spans; check endNanos contains t.
      let lo = 0, hi = bucket.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bucket[mid].startNanos <= t) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      for (let i = idx; i >= 0 && i >= idx - 4; i--) {
        const s = bucket[i];
        if (t >= s.startNanos && t <= s.endNanos) return s;
      }
      return null;
    }

    function showTooltipFor(s, px, py) {
      hoverSpan = s;
      tooltipEl.innerHTML = '';
      const durMs = (s.endNanos - s.startNanos) / 1e6;
      const startMs = (s.startNanos - 0) / 1e6;
      const lines = [
        [s.label, 'label'],
        [`${s.kind} · ${durMs.toFixed(2)} ms`, 'meta'],
        [`start +${startMs.toFixed(2)} ms · log line ${s.lineNumber}${s.truncated ? ' · truncated' : ''}`, 'meta']
      ];
      for (const [text, cls] of lines) {
        const div = document.createElement('div');
        div.className = cls;
        div.textContent = text; // untrusted log text — textContent only
        tooltipEl.appendChild(div);
      }
      if (s.detail && s.detail !== s.label) {
        const div = document.createElement('div');
        div.className = 'detail';
        const d = s.detail;
        div.textContent = d.length > 300 ? d.slice(0, 300) + '…' : d;
        tooltipEl.appendChild(div);
      }
      tooltipEl.style.display = 'block';
      positionTooltipFor(s, px, py);
    }

    function positionTooltipFor(s, px, py) {
      // Keep the tooltip inside the pane; flip left when near the right edge.
      const pad = 12;
      const tw = tooltipEl.offsetWidth || 200;
      const th = tooltipEl.offsetHeight || 40;
      let left = px + pad;
      if (left + tw > view.width) left = px - pad - tw;
      if (left < 0) left = 0;
      let top = py + pad;
      if (top + th > view.height) top = py - pad - th;
      if (top < 0) top = 0;
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    }

    function hideTooltip() {
      hoverSpan = null;
      if (tooltipEl) tooltipEl.style.display = 'none';
    }

    // ---- interactions ----
    let dragging = false;
    let dragMoved = false;
    let dragStartX = 0, dragStartY = 0;
    let dragViewStart = 0, dragViewEnd = 0, dragScrollY = 0;
    let activePointer = null;

    function localPos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('wheel', e => {
      if (view.spans.length === 0) return;
      e.preventDefault();
      const p = localPos(e);
      if (e.ctrlKey) {
        // Zoom around the cursor's time position (ctrl+wheel; also trackpad pinch).
        const anchorT = xToTime(p.x);
        const frac = view.width ? p.x / view.width : 0;
        const factor = Math.exp(e.deltaY * 0.002); // >1 when scrolling down = zoom out
        let newSpan = spanNanos() * factor;
        const full = fullSpan();
        const minSpan = Math.min(full, MIN_NANOS_PER_PX * Math.max(view.width, 1));
        newSpan = Math.max(minSpan, Math.min(full, newSpan));
        view.viewStart = anchorT - frac * newSpan;
        view.viewEnd = view.viewStart + newSpan;
        clampView();
        render();
        return;
      }
      // Pan: horizontal wheel or shift+wheel = time pan; plain vertical wheel =
      // scroll rows when the stack overflows the viewport.
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.shiftKey || horizontal) {
        const delta = horizontal ? e.deltaX : e.deltaY;
        const dt = (delta / Math.max(view.width, 1)) * spanNanos();
        view.viewStart += dt;
        view.viewEnd += dt;
        clampView();
        render();
      } else {
        view.scrollY += e.deltaY;
        clampScroll();
        render();
      }
    }, { passive: false });

    canvas.addEventListener('pointerdown', e => {
      if (view.spans.length === 0) return;
      dragging = true;
      dragMoved = false;
      activePointer = e.pointerId;
      const p = localPos(e);
      dragStartX = p.x;
      dragStartY = p.y;
      dragViewStart = view.viewStart;
      dragViewEnd = view.viewEnd;
      dragScrollY = view.scrollY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      hideTooltip();
    });

    canvas.addEventListener('pointermove', e => {
      const p = localPos(e);
      lastMouse.x = p.x;
      lastMouse.y = p.y;
      if (dragging) {
        const dx = p.x - dragStartX;
        const dy = p.y - dragStartY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
        const span = dragViewEnd - dragViewStart;
        const dt = (dx / Math.max(view.width, 1)) * span;
        view.viewStart = dragViewStart - dt;
        view.viewEnd = dragViewEnd - dt;
        view.scrollY = dragScrollY - dy;
        clampView();
        clampScroll();
        render();
        return;
      }
      // Hover: hit-test + tooltip.
      const s = spanAt(p.x, p.y);
      if (s) showTooltipFor(s, p.x, p.y);
      else hideTooltip();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove('dragging');
      if (activePointer != null) {
        try { canvas.releasePointerCapture(activePointer); } catch (_) { /* ignore */ }
        activePointer = null;
      }
      // A press without meaningful movement is a click → jump to the span's line.
      if (!dragMoved && e) {
        const p = localPos(e);
        const s = spanAt(p.x, p.y);
        if (s) jumpToLine(s.lineNumber);
      }
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('dragging'); });
    canvas.addEventListener('mouseleave', () => { if (!dragging) hideTooltip(); });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => resize());
      ro.observe(bodyEl);
    }
    window.addEventListener('resize', () => resize());

    return { load, showEmpty, showError, resize };
  })();

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'orgs':
        state.orgs = msg.orgs;
        state.selectedOrg = msg.selected;
        renderOrgs();
        break;
      case 'users':
        state.users = msg.users;
        state.selectedUser = msg.selected;
        renderUsers();
        break;
      case 'logs':
        state.logs = msg.logs;
        if (state.activeLogId && !state.logs.some(l => l.id === state.activeLogId)) {
          state.activeLogId = null;
          state.activeUserId = null;
          state.entries = [];
          state.stats = null;
          persistState();
          renderDetailHeader(null);
          renderEntries();
        } else if (state.activeLogId && state.entries.length === 0) {
          // We restored an activeLogId from saved state but have no entries cached
          // (e.g. the user reloaded the window). Ask the host to refetch the body.
          post({ type: 'selectLog', logId: state.activeLogId, userId: state.activeUserId });
        }
        // Drop selections for logs no longer present
        const visible = new Set(state.logs.map(l => l.id));
        for (const id of Array.from(state.selected)) {
          if (!visible.has(id)) state.selected.delete(id);
        }
        renderLogs();
        break;
      case 'logBody':
        state.external = null;
        externalBanner.classList.remove('visible');
        state.entries = msg.entries || [];
        state.stats = msg.stats || null;
        state.truncated = !!msg.truncated;
        state.total = msg.total || state.entries.length;
        state.renderLimit = RENDER_CHUNK;
        persistState();
        renderDetailHeader(msg.stats, msg.logId, false);
        if (msg.downloading) {
          detailHeaderEl.innerHTML = '<span class="empty">Downloading…</span>';
          detailBodyEl.innerHTML = '<div class="empty">Downloading log…</div>';
        } else if (msg.error) {
          detailBodyEl.innerHTML = `<div class="empty">${escapeHtml(msg.error)}</div>`;
        } else {
          renderEntries();
        }
        if (state.activeTab === 'analysis-tab') requestAnalysisIfNeeded();
        if (state.activeTab === 'timeline-tab') requestTimelineIfNeeded();
        break;
      case 'logPatch': {
        // One log in the running fetch changed state (downloaded or failed).
        const patched = msg.log;
        const idx = state.logs.findIndex(l => l.id === patched.id);
        if (idx >= 0) {
          state.logs[idx] = patched;
        } else {
          state.logs.push(patched);
          state.logs.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
        }
        renderLogs();
        // If the user is waiting on this row, load it the moment it's ready.
        if (patched.id === state.activeLogId && !patched.pending) {
          if (patched.failed) {
            detailBodyEl.innerHTML = '<div class="empty">Download failed — run Fetch again to retry.</div>';
          } else {
            post({ type: 'selectLog', logId: patched.id, userId: patched.userId });
          }
        }
        break;
      }
      case 'fetchState':
        state.fetchRunning = !!msg.running;
        updateFetchButton();
        break;
      case 'status':
        setStatus(msg.text, msg.error);
        break;
      case 'commandTrail':
        state.trail = msg.entries || [];
        renderTrail();
        break;
      case 'analysisData':
        state.analysisLoading = false;
        if (msg.logId !== state.analysisFor) break; // stale reply for a since-changed selection
        renderAnalysis(msg.payload);
        break;
      case 'analysisError':
        state.analysisLoading = false;
        if (msg.logId !== state.analysisFor) break;
        renderAnalysisEmpty(`Could not analyze log: ${msg.message}`);
        break;
      case 'timelineData':
        state.timelineLoading = false;
        if (msg.logId !== state.timelineFor) break; // stale reply for a since-changed selection
        timeline.load(msg.spans || [], msg.totalNanos || 0, !!msg.spanCapHit);
        break;
      case 'timelineError':
        state.timelineLoading = false;
        if (msg.logId !== state.timelineFor) break;
        timeline.showError(msg.message);
        break;
      case 'externalLog':
        if (msg.loaded) {
          state.external = { name: msg.name, sourcePath: msg.sourcePath };
          state.activeLogId = null;
          state.activeUserId = null;
          state.entries = msg.entries || [];
          state.truncated = !!msg.truncated;
          state.total = msg.total || state.entries.length;
          state.analysisFor = null;
          state.timelineFor = null;
          externalBanner.classList.add('visible');
          externalPathEl.textContent = msg.sourcePath;
          renderLogs();
          renderDetailHeader(msg.stats, msg.name, true);
          renderEntries();
          if (state.activeTab === 'analysis-tab') requestAnalysisIfNeeded();
          if (state.activeTab === 'timeline-tab') requestTimelineIfNeeded();
        } else {
          state.external = null;
          state.entries = [];
          state.truncated = false;
          state.total = 0;
          state.analysisFor = null;
          state.timelineFor = null;
          externalBanner.classList.remove('visible');
          renderDetailHeader(null);
          renderEntries();
          if (state.activeTab === 'analysis-tab') requestAnalysisIfNeeded();
          if (state.activeTab === 'timeline-tab') requestTimelineIfNeeded();
        }
        break;
    }
  });

  // Paint cached entries immediately so a tab switch doesn't blank the detail pane
  // while the host re-posts orgs/logs. If we have no cached entries but DO have an
  // activeLogId, the 'logs' handler will request the body once the list arrives.
  if (state.entries.length > 0) {
    renderDetailHeader(state.stats, state.activeLogId, false);
    renderEntries();
  }

  post({ type: 'ready' });
})();
