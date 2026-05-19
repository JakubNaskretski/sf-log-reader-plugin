// Client-side webview script for SF Log Reader. Copied verbatim into out/panel.js at build time.
(function () {
  const vscode = acquireVsCodeApi();

  const orgSelect = document.getElementById('org-select');
  const userSelect = document.getElementById('user-select');
  const refreshOrgsBtn = document.getElementById('refresh-orgs');
  const fetchBtn = document.getElementById('fetch-btn');
  const refreshListBtn = document.getElementById('refresh-list');
  const openFolderBtn = document.getElementById('open-folder');
  const clearLogsBtn = document.getElementById('clear-logs');
  const statusEl = document.getElementById('status');
  const logListEl = document.getElementById('log-list');
  const detailHeaderEl = document.getElementById('detail-header');
  const detailBodyEl = document.getElementById('detail-body');
  const searchEl = document.getElementById('search');
  const trailEl = document.getElementById('trail');
  const trailHeader = document.getElementById('trail-header');
  const trailBodyEl = document.getElementById('trail-body');
  const trailCountEl = document.getElementById('trail-count');
  const clearTrailBtn = document.getElementById('clear-trail');

  const state = {
    orgs: [],
    selectedOrg: null,
    users: [],
    selectedUser: null,
    logs: [],
    activeLogId: null,
    activeUserId: null,
    entries: [],
    filters: new Set(['USER_DEBUG', 'SOQL', 'DML', 'EXCEPTION', 'CALLOUT']),
    search: '',
    trail: []
  };

  function post(message) { vscode.postMessage(message); }

  document.querySelectorAll('.filters input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.add(cb.dataset.cat);
      else state.filters.delete(cb.dataset.cat);
      renderEntries();
    });
  });

  searchEl.addEventListener('input', () => {
    state.search = searchEl.value.toLowerCase();
    renderEntries();
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
  clearLogsBtn.addEventListener('click', () => post({ type: 'deleteAllLogs' }));

  trailHeader.addEventListener('click', e => {
    if (e.target === clearTrailBtn) return;
    trailEl.classList.toggle('collapsed');
  });
  clearTrailBtn.addEventListener('click', e => {
    e.stopPropagation();
    post({ type: 'clearCommandTrail' });
  });

  function renderOrgs() {
    orgSelect.innerHTML = '';
    if (state.orgs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No authenticated orgs';
      orgSelect.appendChild(opt);
      orgSelect.disabled = true;
      fetchBtn.disabled = true;
      return;
    }
    orgSelect.disabled = false;
    fetchBtn.disabled = false;
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
      row.addEventListener('click', () => {
        state.activeLogId = log.id;
        state.activeUserId = log.userId;
        renderLogs();
        detailBodyEl.innerHTML = '<div class="empty">Loading…</div>';
        post({ type: 'selectLog', logId: log.id, userId: log.userId });
      });
      row.addEventListener('dblclick', () => {
        post({ type: 'openLogInEditor', logId: log.id, userId: log.userId });
      });

      const top = document.createElement('div');
      top.className = 'row-top';
      const user = document.createElement('span');
      user.className = 'row-user';
      user.textContent = log.userName || log.userId || 'unknown';
      const time = document.createElement('span');
      time.className = 'row-time';
      time.textContent = formatTime(log.startTime);
      top.appendChild(user);
      top.appendChild(time);

      const bot = document.createElement('div');
      bot.className = 'row-bot';
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

      row.appendChild(top);
      row.appendChild(bot);
      logListEl.appendChild(row);
    }
  }

  function renderDetailHeader(stats, logId) {
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
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open file';
    openBtn.title = 'Open the .log file in an editor tab';
    openBtn.addEventListener('click', () => {
      post({ type: 'openLogInEditor', logId, userId: state.activeUserId });
    });
    detailHeaderEl.appendChild(openBtn);
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
    let shown = 0;
    for (const e of state.entries) {
      if (!state.filters.has(e.category)) continue;
      if (search && !e.message.toLowerCase().includes(search) && !e.eventType.toLowerCase().includes(search)) continue;
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
      detailBodyEl.appendChild(row);
      shown += 1;
    }
    if (shown === 0) {
      const em = document.createElement('div');
      em.className = 'empty';
      em.textContent = 'All entries filtered out.';
      detailBodyEl.appendChild(em);
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
          renderDetailHeader(null);
          renderEntries();
        }
        renderLogs();
        break;
      case 'logBody':
        state.entries = msg.entries || [];
        renderDetailHeader(msg.stats, msg.logId);
        if (msg.error) {
          detailBodyEl.innerHTML = `<div class="empty">${escapeHtml(msg.error)}</div>`;
        } else {
          renderEntries();
        }
        break;
      case 'status':
        setStatus(msg.text, msg.error);
        break;
      case 'commandTrail':
        state.trail = msg.entries || [];
        renderTrail();
        break;
    }
  });

  post({ type: 'ready' });
})();
