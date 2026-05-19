import * as vscode from 'vscode';

export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'panel.js'));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>SF Log Reader</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      align-items: center;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .toolbar select, .toolbar button, .toolbar input[type="text"] {
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar input[type="text"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      cursor: text;
      min-width: 140px;
    }
    .toolbar button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
    .toolbar select { min-width: 140px; }
    .toolbar .grow { flex: 1; }
    .status {
      padding: 4px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      min-height: 16px;
    }
    .status.error { color: var(--vscode-testing-iconFailed, #f85149); }
    .filters {
      display: flex;
      gap: 10px;
      padding: 4px 8px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 11px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .filters label {
      display: flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      user-select: none;
    }
    .filters input[type="checkbox"] { cursor: pointer; margin: 0; }
    .filters input[type="text"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 2px 6px;
      font-size: 11px;
      margin-left: auto;
      min-width: 160px;
    }
    .main {
      flex: 1 1 auto;
      display: flex;
      min-height: 0;
      overflow: hidden;
    }
    .log-list {
      flex: 0 0 38%;
      max-width: 38%;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      min-height: 0;
    }
    .log-list-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      flex-shrink: 0;
      background: var(--vscode-panel-background);
    }
    .log-list-header input[type="checkbox"] { margin: 0; cursor: pointer; }
    .log-list-header .count { color: var(--vscode-descriptionForeground); }
    .log-list-header button {
      margin-left: auto;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .log-list-header button:disabled { opacity: 0.5; cursor: not-allowed; }
    .log-list-body {
      flex: 1;
      overflow-y: auto;
    }
    .log-list .empty {
      padding: 12px;
      opacity: 0.6;
      font-style: italic;
    }
    .log-row {
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
      display: flex;
      gap: 6px;
      align-items: flex-start;
    }
    .log-row .row-check { margin-top: 2px; cursor: pointer; }
    .log-row .row-body { flex: 1; min-width: 0; }
    .log-row:hover { background: var(--vscode-list-hoverBackground); }
    .log-row.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .log-row .row-top {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
    }
    .log-row .row-user { font-weight: 600; }
    .log-row .row-time { color: var(--vscode-descriptionForeground); }
    .log-row .row-bot {
      display: flex;
      gap: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .log-row .row-status-success { color: var(--vscode-testing-iconPassed, #2ea043); }
    .log-row .row-status-failed { color: var(--vscode-testing-iconFailed, #f85149); }
    .log-detail {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }
    .detail-header {
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-panel-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      flex-shrink: 0;
    }
    .external-banner {
      padding: 4px 8px;
      font-size: 11px;
      background: var(--vscode-editorInfo-background, rgba(55,148,255,0.08));
      border-bottom: 1px solid var(--vscode-editorInfo-border, var(--vscode-panel-border));
      display: none;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    .external-banner.visible { display: flex; }
    .external-banner .path {
      flex: 1;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground);
      word-break: break-all;
    }
    .external-banner button {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      padding: 1px 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .detail-header .stats { display: flex; gap: 8px; flex-wrap: wrap; }
    .detail-header .stat { white-space: nowrap; }
    .detail-header .stat strong { color: var(--vscode-foreground); }
    .detail-header button {
      margin-left: auto;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .detail-body {
      flex: 1;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 4px 0;
    }
    .detail-body .empty {
      padding: 12px;
      opacity: 0.6;
      font-style: italic;
    }
    .log-entry {
      padding: 2px 8px;
      line-height: 1.4;
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 8px;
      align-items: baseline;
    }
    .log-entry:hover { background: var(--vscode-list-hoverBackground); }
    .log-entry .time { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .log-entry .type { font-weight: 600; font-size: 11px; }
    .log-entry .lineref { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .log-entry .msg {
      word-break: break-word;
      white-space: pre-wrap;
      color: var(--vscode-foreground);
      grid-column: 1 / -1;
      padding-left: 16px;
    }
    .log-entry.search-hit { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.15)); }
    .cat-USER_DEBUG .type { color: var(--vscode-debugConsole-infoForeground, #3794ff); }
    .cat-SOQL .type { color: var(--vscode-editorWarning-foreground, #d29922); }
    .cat-DML .type { color: var(--vscode-charts-purple, #9d4edd); }
    .cat-EXCEPTION .type { color: var(--vscode-testing-iconFailed, #f85149); }
    .cat-CALLOUT .type { color: var(--vscode-charts-green, #2ea043); }
    .cat-CODE_UNIT .type { color: var(--vscode-charts-blue, #3794ff); opacity: 0.85; }
    .cat-METHOD .type { color: var(--vscode-descriptionForeground); }
    .cat-LIMITS .type { color: var(--vscode-charts-orange, #d29922); }
    .cat-SYSTEM .type { color: var(--vscode-descriptionForeground, #8b8b8b); }
    .trail {
      flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border);
      max-height: 40%;
      display: flex;
      flex-direction: column;
      background: var(--vscode-panel-background);
    }
    .trail-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .trail-header .twist { display: inline-block; transition: transform 0.1s; }
    .trail.collapsed .trail-header .twist { transform: rotate(-90deg); }
    .trail-header .count { color: var(--vscode-descriptionForeground); text-transform: none; letter-spacing: 0; }
    .trail-header button {
      margin-left: auto;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      padding: 1px 6px;
      font-size: 10px;
      cursor: pointer;
    }
    .trail-body {
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 4px 0;
    }
    .trail.collapsed .trail-body { display: none; }
    .trail-row {
      padding: 2px 8px;
      display: grid;
      grid-template-columns: 50px auto 1fr 60px;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .trail-row .when { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .trail-row .status-ok { color: var(--vscode-testing-iconPassed, #2ea043); font-size: 10px; }
    .trail-row .status-err { color: var(--vscode-testing-iconFailed, #f85149); font-size: 10px; }
    .trail-row .cmd { word-break: break-all; }
    .trail-row .duration { color: var(--vscode-descriptionForeground); font-size: 10px; text-align: right; }
    .trail-row .note { grid-column: 1 / -1; padding-left: 58px; color: var(--vscode-descriptionForeground); font-style: italic; }
    .trail-row .stderr { grid-column: 1 / -1; padding-left: 58px; color: var(--vscode-testing-iconFailed, #f85149); white-space: pre-wrap; }
    .trail-body .empty { padding: 8px; opacity: 0.6; font-style: italic; }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="org-select" title="Selected org"></select>
    <button id="refresh-orgs" title="Refresh org list">&#x21bb;</button>
    <select id="user-select" title="Filter by user"></select>
    <button id="fetch-btn" class="primary" title="Fetch latest logs from org">&#x2b07; Fetch</button>
    <button id="refresh-list" title="Reload list of locally stored logs">&#x21bb; List</button>
    <button id="open-folder" title="Open local log folder">&#x1f4c1;</button>
    <button id="open-external" title="Open a .log file from disk">&#x1f4c4; Open .log…</button>
    <button id="clear-logs" title="Delete all local logs for this org">&#x1f5d1;</button>
  </div>
  <div class="status" id="status">Ready.</div>
  <div class="filters">
    <label><input type="checkbox" data-cat="USER_DEBUG" checked> USER_DEBUG</label>
    <label><input type="checkbox" data-cat="SOQL" checked> SOQL</label>
    <label><input type="checkbox" data-cat="DML" checked> DML</label>
    <label><input type="checkbox" data-cat="EXCEPTION" checked> EXCEPTION</label>
    <label><input type="checkbox" data-cat="CALLOUT" checked> CALLOUT</label>
    <label><input type="checkbox" data-cat="CODE_UNIT"> CODE_UNIT</label>
    <label><input type="checkbox" data-cat="METHOD"> METHOD</label>
    <label><input type="checkbox" data-cat="LIMITS"> LIMITS</label>
    <label><input type="checkbox" data-cat="SYSTEM"> SYSTEM</label>
    <input type="text" id="search" placeholder="Search log text…" />
  </div>
  <div class="main">
    <div class="log-list">
      <div class="log-list-header">
        <input type="checkbox" id="select-all" title="Select all visible" />
        <span class="count" id="selection-count">0 selected</span>
        <button id="keep-selected" disabled title="Copy selected logs into the saved-logs folder">&#x1f4be; Keep selected</button>
      </div>
      <div class="log-list-body" id="log-list">
        <div class="empty">No logs yet — pick an org and Fetch.</div>
      </div>
    </div>
    <div class="log-detail">
      <div class="external-banner" id="external-banner">
        <span>Viewing external log:</span>
        <span class="path" id="external-path"></span>
        <button id="external-keep" title="Copy this log into the saved-logs folder">&#x1f4be; Keep</button>
        <button id="external-summary" title="Generate a .summary.md next to the source file">Summary</button>
        <button id="external-close" title="Close external view">&times;</button>
      </div>
      <div class="detail-header" id="detail-header">
        <span class="empty">No log selected.</span>
      </div>
      <div class="detail-body" id="detail-body">
        <div class="empty">Pick a log on the left.</div>
      </div>
    </div>
  </div>
  <div class="trail collapsed" id="trail">
    <div class="trail-header" id="trail-header">
      <span class="twist">&#x25bc;</span>
      <span>SF CLI Command Log</span>
      <span class="count" id="trail-count">(0)</span>
      <button id="clear-trail">Clear</button>
    </div>
    <div class="trail-body" id="trail-body">
      <div class="empty">No commands recorded yet.</div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
