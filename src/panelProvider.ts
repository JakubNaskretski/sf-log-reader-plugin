import * as vscode from 'vscode';
import { CommandTrail, CommandTrailEntry } from './commandTrail';
import { OrgStore } from './orgStore';
import { ApexLogRecord, OrgInfo, SfCliError, SfCliService, UserRecord } from './sfCliService';
import { LogStore, StoredLogMeta } from './logStore';
import { generateNonce, getPanelHtml } from './panelHtml';
import { parseLogs, summarize } from './logParser';
import { generateSummary } from './summaryGenerator';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'selectOrg'; username: string }
  | { type: 'refreshOrgs' }
  | { type: 'selectUser'; userId: string | null }
  | { type: 'refreshUsers' }
  | { type: 'fetchLogs' }
  | { type: 'refreshLogs' }
  | { type: 'selectLog'; logId: string; userId: string }
  | { type: 'openLogInEditor'; logId: string; userId: string }
  | { type: 'generateSummary'; logId: string; userId: string }
  | { type: 'deleteAllLogs' }
  | { type: 'clearCommandTrail' }
  | { type: 'openLogFolder' };

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
}

export class LogReaderPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'sfLogReader.panelView';

  private view?: vscode.WebviewView;
  private orgs: OrgInfo[] = [];
  private users: UserRecord[] = [];
  private logsFromOrg: ApexLogRecord[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sf: SfCliService,
    private readonly orgStore: OrgStore,
    private readonly trail: CommandTrail,
    private readonly output: vscode.OutputChannel
  ) {
    this.trail.onChange(() => this.postCommandTrail());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')]
    };
    view.webview.html = getPanelHtml(view.webview, this.context.extensionUri, generateNonce());
    view.webview.onDidReceiveMessage((message: InboundMessage) => this.handleMessage(message));
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
      await this.orgStore.setOrg(picked.username);
      this.postOrgs();
      await this.refreshStoredLogs();
    }
  }

  async pickUser(): Promise<void> {
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

  async fetchLatest(): Promise<void> {
    const org = this.requireOrg();
    if (!org) return;
    const store = this.requireLogStore();
    if (!store) return;
    const config = vscode.workspace.getConfiguration('sfLogReader');
    const limit = config.get<number>('fetchLimit', 25);
    const maxStorageMB = config.get<number>('maxStorageMB', 200);
    const timeoutMs = config.get<number>('commandTimeoutMs', 60_000);
    const orgAlias = org.alias ?? org.username;

    this.postStatus(`Listing latest ${limit} logs from ${orgAlias}…`);
    let records: ApexLogRecord[];
    try {
      records = await this.sf.listLogs(org.username, limit, timeoutMs);
      this.logsFromOrg = records;
    } catch (err) {
      this.reportCliError('list logs', err);
      return;
    }

    const userId = this.orgStore.getUser(org.username);
    const filtered = userId ? records.filter(r => r.LogUserId === userId) : records;
    if (filtered.length === 0) {
      this.postStatus('No matching logs to fetch.');
      return;
    }

    let saved = 0;
    let skipped = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (let i = 0; i < filtered.length; i++) {
      const rec = filtered[i];
      this.postStatus(`Fetching ${i + 1}/${filtered.length}: ${rec.Id}`);
      try {
        if (await store.exists(orgAlias, rec.LogUserId ?? 'unknown', rec.Id)) {
          skipped += 1;
          continue;
        }
        const body = await this.sf.getLogBody(org.username, rec.Id, timeoutMs);
        const result = await store.save(orgAlias, rec, body, org.username);
        if (result.wrote) saved += 1; else skipped += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ id: rec.Id, error: message });
        this.output.appendLine(`[fetch] ${rec.Id} failed: ${message}`);
      }
    }

    this.postStatus(`Fetched ${saved} new · skipped ${skipped} existing · ${failures.length} error${failures.length === 1 ? '' : 's'}`);
    await this.refreshStoredLogs();
    await this.checkStorage(store, orgAlias, maxStorageMB);
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
        await this.loadOrgs();
        this.postCommandTrail();
        await this.refreshStoredLogs();
        return;
      case 'selectOrg':
        await this.orgStore.setOrg(message.username);
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
      case 'openLogInEditor':
        await this.openLogInEditor(message.logId, message.userId);
        return;
      case 'generateSummary':
        await this.generateSummaryFor(message.logId, message.userId);
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
    }
  }

  private async sendLogBody(logId: string, userId: string): Promise<void> {
    const org = this.requireOrg(false);
    const store = this.getLogStore();
    if (!org || !store) return;
    const orgAlias = org.alias ?? org.username;
    const body = await store.readBody(orgAlias, userId, logId);
    if (body === undefined) {
      this.post({ type: 'logBody', logId, body: '', entries: [], stats: null, error: 'Not found locally.' });
      return;
    }
    const entries = parseLogs(body);
    const stats = summarize(entries);
    this.post({ type: 'logBody', logId, body, entries, stats });
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
      const markdown = generateSummary(meta, body);
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

  private async loadOrgs(notifyOnEmpty = false): Promise<void> {
    try {
      const timeoutMs = vscode.workspace.getConfiguration('sfLogReader').get<number>('commandTimeoutMs', 60_000);
      this.orgs = await this.sf.listOrgs(timeoutMs);
      const current = this.orgStore.getOrg();
      if (current && !this.orgs.some(o => o.username === current)) {
        await this.orgStore.setOrg(undefined);
      } else if (!current) {
        const defaultOrg = this.orgs.find(o => o.isDefaultUsername) ?? this.orgs[0];
        if (defaultOrg) await this.orgStore.setOrg(defaultOrg.username);
      }
      this.postOrgs();
      if (notifyOnEmpty && this.orgs.length === 0) {
        vscode.window.showWarningMessage('No authenticated Salesforce orgs found.');
      }
    } catch (err) {
      this.reportCliError('list orgs', err);
    }
  }

  private async loadUsers(org: OrgInfo): Promise<void> {
    try {
      const timeoutMs = vscode.workspace.getConfiguration('sfLogReader').get<number>('commandTimeoutMs', 60_000);
      this.users = await this.sf.listActiveUsers(org.username, timeoutMs);
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
    if (err instanceof SfCliError && err.stderr) this.output.appendLine(err.stderr);
    this.post({ type: 'status', text: `${action} failed — see SF Log Reader output channel`, error: true });
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

  private requireOrg(prompt = true): OrgInfo | undefined {
    const username = this.orgStore.getOrg();
    const org = username ? this.orgs.find(o => o.username === username) : undefined;
    if (!org && prompt) {
      vscode.window.showWarningMessage('Select a Salesforce org first.');
    }
    return org;
  }

  private getLogStore(): LogStore | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const folderName = vscode.workspace.getConfiguration('sfLogReader').get<string>('logFolderName', '.sf-logs');
    return new LogStore(folder.uri, folderName);
  }

  private requireLogStore(): LogStore | undefined {
    const store = this.getLogStore();
    if (!store) {
      vscode.window.showWarningMessage('Open a workspace folder first — fetched logs are saved relative to it.');
    }
    return store;
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }
}
