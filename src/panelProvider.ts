import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CommandTrail, CommandTrailEntry } from './commandTrail';
import { FetchQueue } from './fetchQueue';
import { OrgStore } from './orgStore';
import { SfRestService } from './restClient';
import { ApexLogRecord, OrgInfo, SfCliError, SfCliService, UserRecord } from './sfCliService';
import { LogStore, StoredLogMeta } from './logStore';
import { generateNonce, getPanelHtml } from './panelHtml';
import { parseLogs, summarize } from './logParser';
import { generateSummary } from './summaryGenerator';
import { SavedLogsService } from './savedLogs';
import { capEntries } from './entryCap';
import { TraceService } from './traceService';
import { getSharedOrg, setSharedOrg } from './kit/orgs';
import { buildAnalysis } from './analysisModel';
import { buildCallTree } from './callTree';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'selectOrg'; username: string }
  | { type: 'refreshOrgs' }
  | { type: 'selectUser'; userId: string | null }
  | { type: 'refreshUsers' }
  | { type: 'fetchLogs' }
  | { type: 'refreshLogs' }
  | { type: 'selectLog'; logId: string; userId: string }
  | { type: 'prioritizeLog'; logId: string }
  | { type: 'openLogInEditor'; logId: string; userId: string }
  | { type: 'generateSummary'; logId: string; userId: string }
  | { type: 'keepLog'; logId: string; userId: string }
  | { type: 'keepLogs'; logs: Array<{ logId: string; userId: string }> }
  | { type: 'keepExternalLog' }
  | { type: 'openExternalLog' }
  | { type: 'closeExternalLog' }
  | { type: 'generateExternalSummary' }
  | { type: 'deleteAllLogs' }
  | { type: 'clearCommandTrail' }
  | { type: 'openLogFolder' }
  | { type: 'requestAnalysis'; logId: string; userId?: string; external?: boolean }
  | { type: 'requestTimeline'; logId: string; userId?: string; external?: boolean };

interface OrgViewModel {
  username: string;
  alias?: string;
  label: string;
}

interface UserViewModel {
  id: string;
  name: string;
  username?: string;
  source: 'org' | 'log';
}

interface LogViewModel {
  id: string;
  userId: string;
  userName?: string;
  startTime?: string;
  durationMs?: number;
  logLength?: number;
  status?: string;
  operation?: string;
  application?: string;
  request?: string;
  fetchedAt: string;
  hasSummary: boolean;
  /** Body not stored locally yet — queued or in flight in the current fetch. */
  pending?: boolean;
  /** Body download failed during the current fetch. */
  failed?: boolean;
}

export class LogReaderPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'sfLogReader.panelView';

  private view?: vscode.WebviewView;
  private orgs: OrgInfo[] = [];
  private users: UserRecord[] = [];
  private externalLog: { sourcePath: string; body: string } | null = null;
  private readonly savedLogs = new SavedLogsService();
  private fetchInFlight = false;
  private activeQueue: FetchQueue<ApexLogRecord> | null = null;
  /** Username of the org the running fetch belongs to (null when idle). */
  private activeFetchOrg: string | null = null;
  /** Records of the running fetch whose bodies haven't finished (success or fail) yet. */
  private readonly remainingFetch = new Map<string, ApexLogRecord>();
  private readonly traceService: TraceService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sf: SfCliService,
    private readonly rest: SfRestService,
    private readonly orgStore: OrgStore,
    private readonly trail: CommandTrail,
    private readonly output: vscode.OutputChannel
  ) {
    this.trail.onChange(() => this.postCommandTrail());
    this.traceService = new TraceService(this.rest);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')]
    };
    view.webview.html = getPanelHtml(view.webview, this.context.extensionUri, generateNonce());
    // Never let a handler rejection vanish — a click that dies in an unhandled
    // promise looks like the panel ignoring the user, with no trace anywhere.
    view.webview.onDidReceiveMessage((message: InboundMessage) => {
      void this.handleMessage(message).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[${(message as { type?: string })?.type ?? 'panel message'}] ${msg}`);
        void vscode.window.showErrorMessage(`SF Log Reader: ${msg}`, 'Show Output').then(choice => {
          if (choice === 'Show Output') this.output.show(true);
        });
      });
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  async pickOrg(): Promise<void> {
    if (this.orgs.length === 0) await this.loadOrgs();
    if (this.orgs.length === 0) {
      vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Run `sf org login web` first.');
      return;
    }
    const items = this.orgs.map(org => ({
      label: org.alias ?? org.username,
      description: org.alias ? org.username : undefined,
      detail: org.instanceUrl,
      username: org.username
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select Salesforce org',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (picked) {
      await this.setActiveOrg(picked.username);
      // Clear the previous org's user list — otherwise pickUser()/the dropdown
      // would show/merge stale users from the org we just switched away from
      // (mirrors the webview 'selectOrg' path).
      this.users = [];
      this.postOrgs();
      await this.refreshStoredLogs();
    }
  }

  async pickUser(): Promise<void> {
    await this.ensureOrgLoaded();
    const org = this.requireOrg();
    if (!org) return;
    if (this.users.length === 0) await this.loadUsers(org);
    const items: vscode.QuickPickItem[] = [{ label: '$(clear-all) All users', description: 'Clear filter' }];
    for (const u of this.users) {
      items.push({ label: u.Name, description: u.Username, detail: u.Id });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Filter logs by user' });
    if (!picked) return;
    if (picked.detail) {
      await this.orgStore.setUser(org.username, picked.detail);
    } else {
      await this.orgStore.setUser(org.username, undefined);
    }
    this.postUsers();
    await this.refreshStoredLogs();
  }

  /**
   * "Start capturing" — ensure a DEVELOPER_LOG TraceFlag exists for the current
   * user so the org starts writing debug logs. Explicit user action (toolbar
   * button / palette). Reports success/failure inline.
   */
  async startCapturing(): Promise<void> {
    await this.ensureOrgLoaded();
    const org = this.requireOrg();
    if (!org) return;
    if (!this.rest.available()) {
      this.post({ type: 'status', text: 'Start capturing needs the REST path (global fetch) — unavailable on this VS Code build.', error: true });
      return;
    }
    const timeoutMs = vscode.workspace.getConfiguration('sfLogReader').get<number>('commandTimeoutMs', 60_000);
    try {
      const message = await this.traceService.pickPresetAndEnsure(org.username, org.username, timeoutMs);
      if (message === undefined) return; // picker cancelled
      this.postStatus(message);
    } catch (err) {
      this.reportCliError('start capturing', err);
    }
  }

  /**
   * Best-effort TraceFlag ensure sequenced at the start of a fetch (inside the
   * lock region) so the logs we're about to list actually get written. Non-fatal
   * and quiet: a failure must not block fetching already-existing logs, and we
   * only ensure once REST is available (the ensure uses the REST session).
   */
  private async ensureTraceFlagQuietly(username: string, timeoutMs: number): Promise<void> {
    if (!this.rest.available()) return;
    try {
      await this.traceService.ensureTraceFlag(username, username, timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[trace] could not ensure TraceFlag (non-fatal): ${message}`);
    }
  }

  async fetchLatest(): Promise<void> {
    if (this.fetchInFlight) {
      this.postStatus('A fetch is already running — new logs appear as they arrive.');
      return;
    }
    await this.ensureOrgLoaded();
    const org = this.requireOrg();
    if (!org) return;
    const store = this.requireLogStore();
    if (!store) return;
    const config = vscode.workspace.getConfiguration('sfLogReader');
    const limit = config.get<number>('fetchLimit', 25);
    const concurrency = Math.max(1, Math.min(10, config.get<number>('fetchConcurrency', 5)));
    const maxStorageMB = config.get<number>('maxStorageMB', 200);
    const timeoutMs = config.get<number>('commandTimeoutMs', 60_000);
    const orgAlias = org.alias ?? org.username;

    this.fetchInFlight = true;
    this.post({ type: 'fetchState', running: true });
    try {
      // Optionally ensure a TraceFlag first (inside the lock, before listing) so
      // the org is actively writing logs. Off by default — creating a DebugLevel/
      // TraceFlag mutates the org, so opt in via sfLogReader.autoTraceFlag; the
      // explicit "Start capturing" button is the primary path. Non-fatal.
      if (config.get<boolean>('autoTraceFlag', false)) {
        await this.ensureTraceFlagQuietly(org.username, timeoutMs);
      }
      // Read the user filter up front so it can be applied server-side (WHERE
      // LogUserId=…) — busy orgs otherwise return top-N org-wide logs that the
      // client filter then drops to nothing. The client filter below stays as
      // belt-and-suspenders (an unknown-shaped id, or a REST fallback to CLI,
      // must never surface another user's logs).
      const userId = this.orgStore.getUser(org.username);
      this.postStatus(`Listing latest ${limit} logs from ${orgAlias}…`);
      let records: ApexLogRecord[];
      try {
        records = await this.listLogsFast(org.username, limit, timeoutMs, userId);
      } catch (err) {
        this.reportCliError('list logs', err);
        return;
      }

      const filtered = userId ? records.filter(r => r.LogUserId === userId) : records;
      if (filtered.length === 0) {
        this.postStatus('No matching logs to fetch.');
        return;
      }

      // Partition into already-stored and to-download up front, then show the
      // full list immediately — newest logs render at the top as pending rows
      // while their bodies stream in (the query is StartTime DESC, and the
      // queue preserves that order, so the top of the list fills in first).
      const toDownload: ApexLogRecord[] = [];
      let cached = 0;
      for (const rec of filtered) {
        if (await store.exists(orgAlias, rec.LogUserId ?? 'unknown', rec.Id)) {
          cached += 1;
        } else {
          toDownload.push(rec);
        }
      }
      this.remainingFetch.clear();
      for (const rec of toDownload) this.remainingFetch.set(rec.Id, rec);
      this.activeFetchOrg = org.username;
      await this.refreshStoredLogs();

      if (toDownload.length === 0) {
        this.postStatus(`All ${filtered.length} matching logs already stored locally.`);
        return;
      }

      const total = toDownload.length;
      let completed = 0;
      let saved = 0;
      let viaRest = 0;
      const failures: Array<{ id: string; error: string }> = [];
      const startedAt = Date.now();

      this.postStatus(`Downloading ${total} log${total === 1 ? '' : 's'} (${concurrency} parallel)…`);
      // Re-read org and filter at patch time — the user may change either
      // mid-fetch, and a patch must not push rows into a list that excludes them.
      const patchVisible = (rec: ApexLogRecord): boolean => {
        if (this.orgStore.getOrg() !== org.username) return false;
        const current = this.orgStore.getUser(org.username);
        return !current || rec.LogUserId === current;
      };
      const queue = new FetchQueue(toDownload, rec => rec.Id);
      this.activeQueue = queue;
      await queue.run(concurrency, async rec => {
        try {
          const { body, via } = await this.downloadBody(org.username, rec.Id, timeoutMs);
          if (via === 'rest') viaRest += 1;
          const result = await store.save(orgAlias, rec, body, org.username);
          if (result.wrote) saved += 1;
          if (patchVisible(rec)) this.post({ type: 'logPatch', log: this.toViewModel(rec) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ id: rec.Id, error: message });
          this.output.appendLine(`[fetch] ${rec.Id} failed: ${message}`);
          if (patchVisible(rec)) this.post({ type: 'logPatch', log: this.toViewModel(rec, { failed: true }) });
        } finally {
          this.remainingFetch.delete(rec.Id);
          completed += 1;
          this.postStatus(`Downloading ${completed}/${total} · ${saved} new · ${cached} cached${failures.length ? ` · ${failures.length} error${failures.length === 1 ? '' : 's'}` : ''}`);
        }
      });

      if (viaRest > 0) {
        this.trail.record({
          startedAt,
          durationMs: Date.now() - startedAt,
          cmd: 'REST',
          args: ['GET', `ApexLog/<id>/Body ×${viaRest}`],
          exitCode: failures.length ? 1 : 0,
          ok: failures.length === 0,
          note: `download ${total} log bodies (${viaRest} via REST, ${total - viaRest} via CLI)`
        });
      }
      this.postStatus(`Fetched from ${orgAlias}: ${saved} new · ${cached} already stored · ${failures.length} error${failures.length === 1 ? '' : 's'}`);
      await this.refreshStoredLogs();
    } finally {
      this.fetchInFlight = false;
      this.activeQueue = null;
      this.activeFetchOrg = null;
      this.remainingFetch.clear();
      this.post({ type: 'fetchState', running: false });
    }
    // After the lock is released — checkStorage awaits a notification toast that
    // only resolves on user interaction, and must not keep Fetch disabled.
    await this.checkStorage(store, orgAlias, maxStorageMB);
  }

  /**
   * List log headers via the Tooling REST API when a session is available —
   * after the first fetch the token is cached, making this a single HTTP GET
   * instead of a ~1-3s CLI process — falling back to the CLI on any failure.
   */
  private async listLogsFast(username: string, limit: number, timeoutMs: number, userId?: string): Promise<ApexLogRecord[]> {
    if (this.rest.available()) {
      this.rest.resetIfFailed(username);
      try {
        return await this.rest.queryLogs(username, limit, timeoutMs, userId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[fetch] REST list failed, falling back to CLI: ${message}`);
      }
    }
    return this.sf.listLogs(username, limit, timeoutMs, userId);
  }

  /** Download one log body — REST first (no process spawn), CLI as fallback. */
  private async downloadBody(username: string, logId: string, timeoutMs: number): Promise<{ body: string; via: 'rest' | 'cli' }> {
    if (this.rest.available()) {
      try {
        return { body: await this.rest.fetchLogBody(username, logId, timeoutMs), via: 'rest' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[fetch] REST body failed for ${logId}, falling back to CLI: ${message}`);
      }
    }
    return { body: await this.sf.getLogBody(username, logId, timeoutMs), via: 'cli' };
  }

  private toViewModel(rec: ApexLogRecord, flags: { pending?: boolean; failed?: boolean } = {}): LogViewModel {
    return {
      id: rec.Id,
      userId: rec.LogUserId ?? 'unknown',
      userName: rec.LogUserName,
      startTime: rec.StartTime,
      durationMs: rec.DurationMilliseconds,
      logLength: rec.LogLength,
      status: rec.Status,
      operation: rec.Operation,
      application: rec.Application,
      request: rec.Request,
      fetchedAt: new Date().toISOString(),
      hasSummary: false,
      ...flags
    };
  }

  async refreshStoredLogs(): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.getLogStore();
    if (!org || !store) {
      this.post({ type: 'logs', logs: [] });
      return;
    }
    const orgAlias = org.alias ?? org.username;
    const metas = await store.listStored(orgAlias);
    const userId = this.orgStore.getUser(org.username);
    const filtered = userId ? metas.filter(m => m.LogUserId === userId) : metas;
    const vm: LogViewModel[] = await Promise.all(
      filtered.map(async m => ({
        id: m.Id,
        userId: m.LogUserId ?? 'unknown',
        userName: m.LogUserName,
        startTime: m.StartTime,
        durationMs: m.DurationMilliseconds,
        logLength: m.LogLength,
        status: m.Status,
        operation: m.Operation,
        application: m.Application,
        request: m.Request,
        fetchedAt: m.fetchedAt,
        hasSummary: await store.summaryExists(orgAlias, m.LogUserId ?? 'unknown', m.Id)
      }))
    );
    // While a fetch is running, keep its not-yet-downloaded logs visible as
    // pending rows (a manual refresh must not make them vanish mid-download) —
    // but only while the fetch's org is still the one being displayed.
    if (this.activeFetchOrg === org.username) {
      const storedIds = new Set(vm.map(v => v.id));
      for (const rec of this.remainingFetch.values()) {
        if (storedIds.has(rec.Id)) continue;
        if (userId && rec.LogUserId !== userId) continue;
        vm.push(this.toViewModel(rec, { pending: true }));
      }
    }
    vm.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    this.post({ type: 'logs', logs: vm });
    this.postUsers(metas);
  }

  async openLogFolder(): Promise<void> {
    const store = this.getLogStore();
    if (!store) {
      vscode.window.showWarningMessage('Open a workspace folder first — logs are stored relative to it.');
      return;
    }
    const uri = vscode.Uri.file(store.rootPath());
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  async clearLocalLogs(): Promise<void> {
    const org = this.requireOrg();
    if (!org) return;
    const store = this.requireLogStore();
    if (!store) return;
    const orgAlias = org.alias ?? org.username;
    const confirm = await vscode.window.showWarningMessage(
      `Delete all locally stored logs for ${orgAlias}?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;
    await store.deleteAll(orgAlias);
    await this.refreshStoredLogs();
    this.postStatus(`Cleared local logs for ${orgAlias}.`);
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // The webview is torn down whenever the bottom-pane tab is switched away,
        // so 'ready' fires on every re-show. Reuse cached orgs to avoid re-shelling
        // out to `sf org list` on each tab switch — the provider instance lives
        // across view recreations, so `this.orgs` is still populated.
        if (this.orgs.length > 0) {
          this.postOrgs();
        } else {
          await this.loadOrgs();
        }
        this.postCommandTrail();
        // The recreated webview defaults to "not fetching" — resync the button
        // with any fetch still running from before the tab switch.
        this.post({ type: 'fetchState', running: this.fetchInFlight });
        await this.refreshStoredLogs();
        return;
      case 'selectOrg':
        await this.setActiveOrg(message.username);
        this.users = [];
        this.postOrgs();
        await this.refreshStoredLogs();
        return;
      case 'refreshOrgs':
        await this.loadOrgs(true);
        return;
      case 'selectUser': {
        const org = this.requireOrg(false);
        if (!org) return;
        await this.orgStore.setUser(org.username, message.userId ?? undefined);
        this.postUsers();
        await this.refreshStoredLogs();
        return;
      }
      case 'refreshUsers': {
        const org = this.requireOrg();
        if (org) await this.loadUsers(org);
        return;
      }
      case 'fetchLogs':
        await this.fetchLatest();
        return;
      case 'refreshLogs':
        await this.refreshStoredLogs();
        return;
      case 'selectLog':
        await this.sendLogBody(message.logId, message.userId);
        return;
      case 'prioritizeLog':
        // User clicked a pending row — bump its body to the front of the queue.
        this.activeQueue?.prioritize(message.logId);
        return;
      case 'openLogInEditor':
        await this.openLogInEditor(message.logId, message.userId);
        return;
      case 'generateSummary':
        await this.generateSummaryFor(message.logId, message.userId);
        return;
      case 'keepLog':
        await this.keepLog(message.logId, message.userId);
        return;
      case 'keepLogs':
        await this.keepLogs(message.logs);
        return;
      case 'keepExternalLog':
        await this.keepExternalLog();
        return;
      case 'openExternalLog':
        await this.openExternalLog();
        return;
      case 'closeExternalLog':
        this.externalLog = null;
        this.post({ type: 'externalLog', loaded: false });
        return;
      case 'generateExternalSummary':
        await this.generateExternalSummary();
        return;
      case 'deleteAllLogs':
        await this.clearLocalLogs();
        return;
      case 'clearCommandTrail':
        this.trail.clear();
        return;
      case 'openLogFolder':
        await this.openLogFolder();
        return;
      case 'requestAnalysis':
        await this.sendAnalysis(message.logId, message.userId, message.external);
        return;
      case 'requestTimeline':
        await this.sendTimeline(message.logId, message.userId, message.external);
        return;
    }
  }

  private async sendTimeline(logId: string, userId: string | undefined, external: boolean | undefined): Promise<void> {
    try {
      const body = await this.loadBodyFor(logId, userId, external);
      if (body === undefined) {
        this.post({ type: 'timelineError', logId, message: 'Log body not available locally.' });
        return;
      }
      const { spans, totalNanos, spanCapHit } = buildCallTree(parseLogs(body));
      this.post({ type: 'timelineData', logId, spans, totalNanos, spanCapHit });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[timeline] ${message}`);
      this.post({ type: 'timelineError', logId, message });
    }
  }

  /**
   * Resolve a log body for the per-tab data requests (analysis / timeline):
   * external logs are keyed by source path (sent back as logId, mirroring
   * openExternalLog); stored logs are read by (orgAlias, userId, logId).
   */
  private async loadBodyFor(logId: string, userId: string | undefined, external: boolean | undefined): Promise<string | undefined> {
    if (external) {
      if (this.externalLog && this.externalLog.sourcePath === logId) return this.externalLog.body;
      return undefined;
    }
    const org = this.requireOrg(false);
    const store = this.getLogStore();
    if (org && store && userId) {
      return store.readBody(org.alias ?? org.username, userId, logId);
    }
    return undefined;
  }

  private async sendAnalysis(logId: string, userId: string | undefined, external: boolean | undefined): Promise<void> {
    try {
      const body = await this.loadBodyFor(logId, userId, external);
      if (body === undefined) {
        this.post({ type: 'analysisError', logId, message: 'Log body not available locally.' });
        return;
      }
      const payload = buildAnalysis(body);
      this.post({ type: 'analysisData', logId, payload });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[analysis] ${message}`);
      this.post({ type: 'analysisError', logId, message });
    }
  }

  private async sendLogBody(logId: string, userId: string): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.getLogStore();
    if (!org || !store) return;
    const orgAlias = org.alias ?? org.username;
    const body = await store.readBody(orgAlias, userId, logId);
    if (body === undefined) {
      if (this.activeQueue?.isOutstanding(logId)) {
        // Still downloading — bump it and let the webview wait for its logPatch.
        this.activeQueue.prioritize(logId);
        this.post({ type: 'logBody', logId, entries: [], stats: null, downloading: true });
        return;
      }
      this.post({ type: 'logBody', logId, entries: [], stats: null, error: 'Not found locally.' });
      return;
    }
    const entries = parseLogs(body);
    const stats = summarize(entries);
    // The webview renders parsed entries only — the raw body stays out of the
    // message; serializing multi-MB strings across the bridge is pure overhead.
    // Cap the entries crossing postMessage: a 20 MB log parses to hundreds of
    // thousands of entries, and posting the whole array on every row click is a
    // huge structured clone the webview only ever renders `renderLimit` of at a
    // time. Stats stay computed over the FULL log so the header counts are true;
    // the user opens the .log file for the untruncated view.
    const { entries: capped, truncated } = capEntries(entries);
    this.post({ type: 'logBody', logId, userId, entries: capped, stats, total: entries.length, truncated });
  }

  async keepLog(logId: string, userId: string): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.requireLogStore();
    if (!org || !store) return;
    const orgAlias = org.alias ?? org.username;
    const body = await store.readBody(orgAlias, userId, logId);
    if (body === undefined) {
      vscode.window.showWarningMessage('Log not found locally — fetch it first.');
      return;
    }
    const metas = await store.listStored(orgAlias);
    const meta = metas.find(m => m.Id === logId);
    if (!meta) {
      vscode.window.showWarningMessage('Log metadata not found locally.');
      return;
    }
    let summary: string | undefined;
    if (await store.summaryExists(orgAlias, userId, logId)) {
      try {
        summary = await fs.readFile(store.summaryPath(orgAlias, userId, logId), 'utf8');
      } catch { /* ignore */ }
    }
    try {
      const result = await this.savedLogs.save(this.savedLogsFolderSetting(), { body, meta, summary });
      this.postStatus(`Saved to ${this.displayPath(result.logPath)}`);
      this.offerReveal(result.logPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[keep] ${message}`);
      vscode.window.showErrorMessage(`Failed to save log: ${message}`);
    }
  }

  async keepLogs(targets: Array<{ logId: string; userId: string }>): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.requireLogStore();
    if (!org || !store || targets.length === 0) return;
    const orgAlias = org.alias ?? org.username;
    const folderSetting = this.savedLogsFolderSetting();
    const metas = await store.listStored(orgAlias);
    let saved = 0;
    const failures: string[] = [];
    let lastPath = '';
    for (let i = 0; i < targets.length; i++) {
      const { logId, userId } = targets[i];
      this.postStatus(`Saving ${i + 1}/${targets.length}: ${logId}`);
      try {
        const body = await store.readBody(orgAlias, userId, logId);
        const meta = metas.find(m => m.Id === logId);
        if (body === undefined || !meta) {
          failures.push(logId);
          continue;
        }
        let summary: string | undefined;
        if (await store.summaryExists(orgAlias, userId, logId)) {
          try { summary = await fs.readFile(store.summaryPath(orgAlias, userId, logId), 'utf8'); } catch { /* ignore */ }
        }
        const result = await this.savedLogs.save(folderSetting, { body, meta, summary });
        lastPath = result.logPath;
        saved += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[keep:${logId}] ${message}`);
        failures.push(logId);
      }
    }
    const msg = `Saved ${saved}/${targets.length}${failures.length ? ` · ${failures.length} failed` : ''}`;
    this.postStatus(msg);
    if (lastPath) {
      const folder = path.dirname(lastPath);
      void vscode.window.showInformationMessage(msg, 'Reveal folder').then(choice => {
        if (choice === 'Reveal folder') {
          void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
        }
      });
    }
  }

  async keepExternalLog(): Promise<void> {
    if (!this.externalLog) {
      vscode.window.showWarningMessage('No external log loaded.');
      return;
    }
    const { sourcePath, body } = this.externalLog;
    let summary: string | undefined;
    const sibling = sourcePath.replace(/\.[^.]+$/, '') + '.summary.md';
    try {
      summary = await fs.readFile(sibling, 'utf8');
    } catch { /* no sibling summary */ }
    try {
      const result = await this.savedLogs.saveExternal(this.savedLogsFolderSetting(), sourcePath, body, summary);
      this.postStatus(`Saved to ${this.displayPath(result.logPath)}`);
      this.offerReveal(result.logPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[keep:external] ${message}`);
      vscode.window.showErrorMessage(`Failed to save log: ${message}`);
    }
  }

  async openSavedLogsFolder(): Promise<void> {
    const folder = this.savedLogs.resolveFolder(this.savedLogsFolderSetting());
    try {
      await fs.mkdir(folder, { recursive: true });
    } catch { /* ignore */ }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
  }

  private savedLogsFolderSetting(): string {
    // Default matches the manifest (empty string) — SavedLogsService maps '' to
    // ~/sf-saved-logs. The old 'saved-logs' code fallback diverged from the
    // manifest default and would have resolved to a workspace-relative folder if
    // the setting were ever read before the manifest default applied.
    return vscode.workspace.getConfiguration('sfLogReader').get<string>('savedLogsFolder', '');
  }

  private displayPath(absolute: string): string {
    const relative = vscode.workspace.asRelativePath(absolute, false);
    return relative === absolute ? absolute : relative;
  }

  private offerReveal(absolute: string): void {
    void vscode.window.showInformationMessage(`Saved ${path.basename(absolute)}`, 'Reveal').then(choice => {
      if (choice === 'Reveal') {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolute));
      }
    });
  }

  async openExternalLog(uri?: vscode.Uri): Promise<void> {
    let target = uri;
    if (!target) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open log',
        filters: { 'Apex log': ['log', 'txt'], 'All files': ['*'] }
      });
      if (!picked || picked.length === 0) return;
      target = picked[0];
    }
    try {
      const body = await fs.readFile(target.fsPath, 'utf8');
      this.externalLog = { sourcePath: target.fsPath, body };
      const entries = parseLogs(body);
      const stats = summarize(entries);
      // Same host-side cap as the stored-log path — a large external .log must
      // not push its full parsed array across the bridge.
      const { entries: capped, truncated } = capEntries(entries);
      this.post({
        type: 'externalLog',
        loaded: true,
        name: path.basename(target.fsPath),
        sourcePath: target.fsPath,
        entries: capped,
        stats,
        total: entries.length,
        truncated
      });
      this.postStatus(`Viewing ${vscode.workspace.asRelativePath(target.fsPath)} (${entries.length} entries)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Could not read ${target.fsPath}: ${message}`);
    }
  }

  async generateExternalSummary(): Promise<void> {
    if (!this.externalLog) {
      vscode.window.showWarningMessage('No external log loaded.');
      return;
    }
    const { sourcePath, body } = this.externalLog;
    const basename = path.basename(sourcePath);
    const synthMeta: StoredLogMeta = {
      Id: basename,
      orgUsername: '(local file)',
      orgAlias: 'imported',
      fetchedAt: new Date().toISOString(),
      LogLength: body.length
    };
    try {
      const markdown = generateSummary(synthMeta, body, this.mermaidOptions());
      const target = sourcePath.replace(/\.[^.]+$/, '') + '.summary.md';
      await fs.writeFile(target, markdown, 'utf8');
      this.postStatus(`Summary written to ${vscode.workspace.asRelativePath(target)}`);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(target));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[summary:external] ${message}`);
      vscode.window.showErrorMessage(`Failed to generate summary: ${message}`);
    }
  }

  async generateSummaryFor(logId: string, userId: string): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.requireLogStore();
    if (!org || !store) return;
    const orgAlias = org.alias ?? org.username;
    const body = await store.readBody(orgAlias, userId, logId);
    if (body === undefined) {
      vscode.window.showWarningMessage('Log not found locally — fetch it first.');
      return;
    }
    const metas = await store.listStored(orgAlias);
    const meta = metas.find(m => m.Id === logId);
    if (!meta) {
      vscode.window.showWarningMessage('Log metadata not found locally.');
      return;
    }
    try {
      const markdown = generateSummary(meta, body, this.mermaidOptions());
      const target = await store.writeSummary(orgAlias, userId, logId, markdown);
      this.postStatus(`Summary written to ${vscode.workspace.asRelativePath(target)}`);
      await this.refreshStoredLogs();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(target));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[summary] ${message}`);
      vscode.window.showErrorMessage(`Failed to generate summary: ${message}`);
    }
  }

  private mermaidOptions(): { mermaidMaxEdges: number; mermaidMaxNodes: number } {
    const cfg = vscode.workspace.getConfiguration('sfLogReader');
    return {
      mermaidMaxEdges: cfg.get<number>('mermaidMaxEdges', 400),
      mermaidMaxNodes: cfg.get<number>('mermaidMaxNodes', 60)
    };
  }

  private async openLogInEditor(logId: string, userId: string): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.getLogStore();
    if (!org || !store) return;
    const orgAlias = org.alias ?? org.username;
    const filePath = store.logPath(orgAlias, userId, logId);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Could not open ${filePath}: ${message}`);
    }
  }

  /** Shared in-flight org load — webview `ready`, the org picker, the shared-org
   *  config watcher and the fetch/capture commands can all request one at the
   *  same moment; share a single `sf org list` instead of one spawn per caller. */
  private loadOrgsInflight?: Promise<void>;

  private loadOrgs(notifyOnEmpty = false): Promise<void> {
    const inflight = this.loadOrgsInflight;
    if (inflight) {
      // Joining a silent load must not swallow an explicit refresh's warning.
      if (!notifyOnEmpty) return inflight;
      return inflight.then(() => {
        if (this.orgs.length === 0) vscode.window.showWarningMessage('No authenticated Salesforce orgs found.');
      });
    }
    return this.loadOrgsInflight = this.doLoadOrgs(notifyOnEmpty).finally(() => { this.loadOrgsInflight = undefined; });
  }

  private async doLoadOrgs(notifyOnEmpty: boolean): Promise<void> {
    try {
      const timeoutMs = vscode.workspace.getConfiguration('sfLogReader').get<number>('commandTimeoutMs', 60_000);
      this.orgs = await this.sf.listOrgs(timeoutMs);
      // Consider the shared cross-plugin setting, not just the private store, so
      // an org chosen in a sibling plugin survives the auto-select below. Adopt
      // it into the private store when present so postOrgs/getUser key on it.
      const current = this.effectiveOrgUsername();
      // Clear the shared selection ONLY on a genuinely non-empty listing that
      // omits the current org (a real "org gone"). A failed `sf org list` throws
      // (caught below, this.orgs untouched, so the clear is unreachable), and an
      // empty listing is treated as a transient blip — never a wipe. Clearing the
      // shared setting off one flaky/empty result would yank the org out from
      // under every sibling family plugin.
      if (this.orgs.length > 0 && current && !this.orgs.some(o => o.username === current)) {
        await this.setActiveOrg(undefined);
      } else if (current && this.orgStore.getOrg() !== current) {
        await this.orgStore.setOrg(current);
      } else if (!current) {
        const defaultOrg = this.orgs.find(o => o.isDefaultUsername) ?? this.orgs[0];
        if (defaultOrg) await this.setActiveOrg(defaultOrg.username);
      }
      this.postOrgs();
      if (notifyOnEmpty && this.orgs.length === 0) {
        vscode.window.showWarningMessage('No authenticated Salesforce orgs found.');
      }
    } catch (err) {
      this.reportCliError('list orgs', err);
    }
  }

  /** Same single-flight idea, keyed by org — the user picker and the refresh
   *  message both load users for the CURRENT org; a request for a different org
   *  (org just switched) must not join the stale load, so it runs fresh. */
  private loadUsersInflight?: { org: string; promise: Promise<void> };

  private loadUsers(org: OrgInfo): Promise<void> {
    if (this.loadUsersInflight?.org === org.username) return this.loadUsersInflight.promise;
    const promise = this.doLoadUsers(org).finally(() => {
      if (this.loadUsersInflight?.promise === promise) this.loadUsersInflight = undefined;
    });
    this.loadUsersInflight = { org: org.username, promise };
    return promise;
  }

  private async doLoadUsers(org: OrgInfo): Promise<void> {
    try {
      const timeoutMs = vscode.workspace.getConfiguration('sfLogReader').get<number>('commandTimeoutMs', 60_000);
      const users = await this.sf.listActiveUsers(org.username, timeoutMs);
      // Landing guard: the org may have switched while this list was in flight.
      // Without it, org-A's users would overwrite this.users and post under org-B
      // (the in-flight dedupe keys by org, but a switch-away still lands here).
      if (this.orgStore.getOrg() !== org.username) return;
      this.users = users;
      this.postUsers();
    } catch (err) {
      this.reportCliError('list users', err);
    }
  }

  private postOrgs(): void {
    const orgs: OrgViewModel[] = this.orgs.map(o => ({
      username: o.username,
      alias: o.alias,
      label: o.alias ? `${o.alias} (${o.username})` : o.username
    }));
    this.post({
      type: 'orgs',
      orgs,
      selected: this.orgStore.getOrg() ?? null
    });
  }

  private postUsers(metas?: StoredLogMeta[]): void {
    const org = this.requireOrg(false);
    const map = new Map<string, UserViewModel>();
    for (const u of this.users) {
      map.set(u.Id, { id: u.Id, name: u.Name, username: u.Username, source: 'org' });
    }
    if (metas) {
      for (const m of metas) {
        if (!m.LogUserId) continue;
        if (!map.has(m.LogUserId)) {
          map.set(m.LogUserId, {
            id: m.LogUserId,
            name: m.LogUserName ?? m.LogUserId,
            source: 'log'
          });
        }
      }
    }
    const list = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.post({
      type: 'users',
      users: list,
      selected: org ? this.orgStore.getUser(org.username) ?? null : null
    });
  }

  private postCommandTrail(): void {
    const trail: CommandTrailEntry[] = this.trail.all();
    this.post({ type: 'commandTrail', entries: trail });
  }

  private postStatus(text: string): void {
    this.post({ type: 'status', text });
    this.output.appendLine(`[status] ${text}`);
  }

  private reportCliError(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[${action}] error: ${message}`);
    const stderr = err instanceof SfCliError ? err.stderr : undefined;
    if (stderr) this.output.appendLine(stderr);
    // Surface the actual reason inline (not just "see the output channel") so the
    // user can act on it — e.g. CLI not found, not authenticated, expired session.
    const snippet = ((stderr && stderr.trim()) || message).split('\n')[0].slice(0, 200);
    this.post({ type: 'status', text: `${action} failed: ${snippet}`, error: true });
    void vscode.window.showErrorMessage(`SF Log Reader: ${action} failed. ${snippet}`, 'Show Output').then(choice => {
      if (choice === 'Show Output') this.output.show(true);
    });
  }

  private async checkStorage(store: LogStore, orgAlias: string, maxMB: number): Promise<void> {
    const bytes = await store.storageBytes(orgAlias);
    const maxBytes = maxMB * 1024 * 1024;
    if (bytes <= maxBytes) return;
    const usedMB = (bytes / 1024 / 1024).toFixed(1);
    const choice = await vscode.window.showInformationMessage(
      `Local logs for ${orgAlias} use ${usedMB} MB (cap ${maxMB} MB). Delete oldest 10?`,
      'Delete 10 oldest',
      'Open folder',
      'Ignore'
    );
    if (choice === 'Delete 10 oldest') {
      const removed = await store.deleteOldest(orgAlias, 10);
      this.postStatus(`Deleted ${removed} oldest log(s).`);
      await this.refreshStoredLogs();
    } else if (choice === 'Open folder') {
      await this.openLogFolder();
    }
  }

  /**
   * Resolve the effective target-org username: the private store first, then the
   * shared cross-plugin setting (`skrety.salesforce.targetOrg`) as a fallback so
   * an org selected in a sibling family plugin is honored here too.
   */
  private effectiveOrgUsername(): string | undefined {
    return this.orgStore.getOrg() ?? getSharedOrg();
  }

  /**
   * Persist a user-chosen target org to BOTH the private store and the shared
   * cross-plugin setting (`skrety.salesforce.targetOrg`) so a switch here also
   * moves sibling family plugins. The shared-org config watcher
   * in extension.ts no-ops when the value is unchanged, so this doesn't loop.
   */
  private async setActiveOrg(username: string | undefined): Promise<void> {
    await this.orgStore.setOrg(username);
    await setSharedOrg(username);
  }

  /**
   * React to a shared-org change made by a sibling plugin (or the user editing
   * the setting): adopt it into the private store and refresh, but only when it
   * actually differs from what we already have (avoids a redundant reload when
   * we were the writer).
   */
  async onSharedOrgChanged(username: string | undefined): Promise<void> {
    if (username === this.orgStore.getOrg()) return;
    await this.orgStore.setOrg(username);
    // Drop the previous org's users from memory; the posts below replace them in
    // the webview too (clearing this.users alone leaves org-A's names rendered in
    // the filter until the next postUsers).
    this.users = [];
    // An external switch can name an org authenticated since our last
    // `sf org list`, so it may be absent from the cached list. Reload then —
    // otherwise the dropdown has no option to select it and requireOrg() fails
    // the fetch commands with "Select a Salesforce org first". (The old check
    // only reloaded when the whole list was empty.)
    const needReload = username ? !this.orgs.some(o => o.username === username) : false;
    if (needReload) await this.loadOrgs();
    this.postOrgs();
    // Refresh the user filter for the new org — load its users, or post an empty
    // list when no org resolves — so nothing from the previous org lingers. Runs
    // before refreshStoredLogs so its postUsers(metas) lands last with this.users
    // populated (org users ∪ log-derived users).
    const org = this.requireOrg(false);
    if (org) await this.loadUsers(org);
    else this.postUsers();
    await this.refreshStoredLogs();
  }

  /**
   * Ensure the org list is loaded and a target org is resolved before a palette
   * command that would otherwise fail cold (the panel — and its 'ready' load —
   * may never have opened). Seeds the store from the shared setting when needed.
   * Handles the palette-before-panel case.
   */
  private async ensureOrgLoaded(): Promise<void> {
    // Adopt a shared-setting org into the private store so requireOrg's in-memory
    // lookup (and getUser keying) resolve it consistently.
    if (!this.orgStore.getOrg()) {
      const shared = getSharedOrg();
      if (shared) await this.orgStore.setOrg(shared);
    }
    if (this.orgs.length === 0) await this.loadOrgs();
  }

  private requireOrg(prompt = true): OrgInfo | undefined {
    const username = this.effectiveOrgUsername();
    const org = username ? this.orgs.find(o => o.username === username) : undefined;
    if (!org && prompt) {
      vscode.window.showWarningMessage('Select a Salesforce org first.');
    }
    return org;
  }

  private getLogStore(): LogStore | undefined {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const setting = (vscode.workspace.getConfiguration('sfLogReader').get<string>('logFolderName', '') ?? '').trim();
    let basePath: string;
    if (!setting) {
      // Default: global storage, partitioned per workspace — or a shared partition
      // when no workspace is open, so the extension still works on loose .log files.
      const key = workspace ? workspaceKey(workspace) : 'no-workspace';
      basePath = path.join(this.context.globalStorageUri.fsPath, 'logs', key);
    } else if (setting.startsWith('~')) {
      basePath = path.join(os.homedir(), setting.slice(1));
    } else if (path.isAbsolute(setting)) {
      basePath = setting;
    } else {
      // Only a workspace-relative path genuinely needs an open workspace folder.
      if (!workspace) return undefined;
      basePath = path.join(workspace.uri.fsPath, setting);
    }
    return new LogStore(basePath);
  }

  private requireLogStore(): LogStore | undefined {
    const store = this.getLogStore();
    if (!store) {
      vscode.window.showWarningMessage(
        'The `sfLogReader.logFolderName` setting is a workspace-relative path but no folder is open. Open a folder, or set it to an absolute path or one starting with `~/`.'
      );
    }
    return store;
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }
}

function workspaceKey(workspace: vscode.WorkspaceFolder): string {
  const name = workspace.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'workspace';
  const hash = crypto.createHash('sha1').update(workspace.uri.fsPath).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

const LEGACY_MIGRATION_KEY = 'sfLogReader.legacyMigration.v1';

export async function migrateLegacyStorage(context: vscode.ExtensionContext): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) return;
  if (context.workspaceState.get<boolean>(LEGACY_MIGRATION_KEY)) return;

  const cfg = vscode.workspace.getConfiguration('sfLogReader');
  const logSetting = (cfg.get<string>('logFolderName', '') ?? '').trim();
  const savedSetting = (cfg.get<string>('savedLogsFolder', '') ?? '').trim();

  const moves: Array<{ from: string; to: string; label: string }> = [];
  if (!logSetting) {
    const from = path.join(workspace.uri.fsPath, '.sf-logs');
    if (await dirHasContent(from)) {
      moves.push({ from, to: path.join(context.globalStorageUri.fsPath, 'logs', workspaceKey(workspace)), label: '.sf-logs' });
    }
  }
  if (!savedSetting) {
    const from = path.join(workspace.uri.fsPath, 'saved-logs');
    if (await dirHasContent(from)) {
      moves.push({ from, to: path.join(os.homedir(), 'sf-saved-logs'), label: 'saved-logs' });
    }
  }

  if (moves.length === 0) {
    await context.workspaceState.update(LEGACY_MIGRATION_KEY, true);
    return;
  }

  const moved: string[] = [];
  const failed: string[] = [];
  for (const m of moves) {
    try {
      await fs.mkdir(m.to, { recursive: true });
      await mergeMove(m.from, m.to);
      await pruneEmptyDirs(m.from);
      moved.push(m.label);
    } catch (err) {
      failed.push(`${m.label}: ${(err as Error).message}`);
    }
  }

  if (failed.length === 0) {
    await context.workspaceState.update(LEGACY_MIGRATION_KEY, true);
  }
  if (moved.length > 0) {
    vscode.window.showInformationMessage(
      `SF Log Reader: moved ${moved.join(' and ')} out of the workspace so they no longer appear in git. New location: global storage / ~/sf-saved-logs.`
    );
  }
  if (failed.length > 0) {
    vscode.window.showWarningMessage(`SF Log Reader: migration issues — ${failed.join('; ')}`);
  }
}

async function dirHasContent(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function mergeMove(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      await mergeMove(from, to);
    } else {
      try {
        await fs.access(to);
        await fs.rm(from, { force: true });
      } catch {
        try {
          await fs.rename(from, to);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            await fs.copyFile(from, to);
            await fs.rm(from, { force: true });
          } else {
            throw err;
          }
        }
      }
    }
  }
}

async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await pruneEmptyDirs(full);
    } catch {
      // skip
    }
  }
  try {
    await fs.rmdir(dir);
  } catch {
    // not empty or already gone
  }
}
