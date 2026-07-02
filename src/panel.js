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
    renderLimit: RENDER_CHUNK
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
      case 'externalLog':
        if (msg.loaded) {
          state.external = { name: msg.name, sourcePath: msg.sourcePath };
          state.activeLogId = null;
          state.activeUserId = null;
          state.entries = msg.entries || [];
          state.truncated = !!msg.truncated;
          state.total = msg.total || state.entries.length;
          externalBanner.classList.add('visible');
          externalPathEl.textContent = msg.sourcePath;
          renderLogs();
          renderDetailHeader(msg.stats, msg.name, true);
          renderEntries();
        } else {
          state.external = null;
          state.entries = [];
          state.truncated = false;
          state.total = 0;
          externalBanner.classList.remove('visible');
          renderDetailHeader(null);
          renderEntries();
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
