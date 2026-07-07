import * as vscode from 'vscode';
import { CommandTrail } from './commandTrail';
import { SfCliService, normalizeApiVersion } from './sfCliService';
import { SfRestService } from './restClient';
import { OrgStore } from './orgStore';
import { LogReaderPanelProvider, migrateLegacyStorage } from './panelProvider';
import { migrateToSharedOrg, onSharedOrgChange } from './kit/orgs';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Log Reader');
  const trail = new CommandTrail();
  const sf = new SfCliService(trail);
  const rest = new SfRestService(sf, trail, undefined, () => {
    // Honor sfLogReader.apiVersion only when the user set it explicitly —
    // the package.json default should not shadow the org's own API version.
    const inspected = vscode.workspace.getConfiguration('sfLogReader').inspect<string>('apiVersion');
    const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    return explicit ? normalizeApiVersion(explicit) : undefined;
  });
  const orgStore = new OrgStore(context.globalState);
  const provider = new LogReaderPanelProvider(context, sf, rest, orgStore, trail, output);

  migrateLegacyStorage(context).catch(err => {
    output.appendLine(`Legacy storage migration failed: ${(err as Error).message}`);
  });

  // One-time seed of the shared cross-plugin org setting from this plugin's
  // private key (no-ops once the shared setting is populated). Adopt the
  // resolved value into the private store so both stay in sync. The setting
  // SCHEMA is contributed by sf-org-deploy-helper only — we read/write it
  // undeclared.
  migrateToSharedOrg(orgStore.getOrg())
    .then(effective => { if (effective && effective !== orgStore.getOrg()) return orgStore.setOrg(effective); })
    .catch(err => output.appendLine(`Shared-org seed failed: ${(err as Error).message}`));

  context.subscriptions.push(
    output,
    // React to org changes made by a sibling family plugin via the shared setting.
    onSharedOrgChange(username => {
      provider.onSharedOrgChanged(username).catch(err =>
        output.appendLine(`Shared-org change handling failed: ${(err as Error).message}`)
      );
    }),
    vscode.window.registerWebviewViewProvider(LogReaderPanelProvider.viewType, provider),
    registerSafe('sfLogReader.refresh', () => provider.refreshStoredLogs()),
    registerSafe('sfLogReader.fetchLatest', () => provider.fetchLatest()),
    registerSafe('sfLogReader.startCapturing', () => provider.startCapturing()),
    registerSafe('sfLogReader.selectOrg', () => provider.pickOrg()),
    registerSafe('sfLogReader.selectUser', () => provider.pickUser()),
    registerSafe('sfLogReader.openLogFolder', () => provider.openLogFolder()),
    registerSafe('sfLogReader.clearLocalLogs', () => provider.clearLocalLogs()),
    registerSafe('sfLogReader.generateSummary', async () => {
      const logId = await vscode.window.showInputBox({ prompt: 'ApexLog Id (07L…) to summarize' });
      const userId = await vscode.window.showInputBox({ prompt: 'LogUserId (005…) that owns the log' });
      if (logId && userId) await provider.generateSummaryFor(logId, userId);
    }),
    registerSafe('sfLogReader.openLogFile', (uri?: vscode.Uri) => provider.openExternalLog(uri)),
    registerSafe('sfLogReader.openSavedLogsFolder', () => provider.openSavedLogsFolder())
  );

  // A rejected command handler (e.g. the org pick failing to save the shared
  // setting) is otherwise an unhandled rejection the user never sees.
  function registerSafe(id: string, fn: (...args: [vscode.Uri?]) => Promise<unknown> | void): vscode.Disposable {
    return vscode.commands.registerCommand(id, (...args: [vscode.Uri?]) => {
      void Promise.resolve(fn(...args)).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[${id}] ${msg}`);
        void vscode.window.showErrorMessage(`SF Log Reader: ${msg}`, 'Show Output').then(choice => {
          if (choice === 'Show Output') output.show(true);
        });
      });
    });
  }
}

export function deactivate(): void {
  // no-op
}
