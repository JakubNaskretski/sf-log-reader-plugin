import * as vscode from 'vscode';
import { CommandTrail } from './commandTrail';
import { SfCliService, normalizeApiVersion } from './sfCliService';
import { SfRestService } from './restClient';
import { OrgStore } from './orgStore';
import { LogReaderPanelProvider, migrateLegacyStorage } from './panelProvider';
import { getSharedOrg, onSharedOrgChange } from './kit/orgs';
import { onOrgSyncEnabled, reconcileOrgOnActivation } from './orgSync';

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

  // Reconcile our OWN org key against the family-shared setting: a one-time
  // migration, then (only with sfLogReader.syncOrgWithFamily on) adopt the shared
  // org. Never writes the shared setting — this plugin's org is its own unless
  // the user opts into syncing. The shared setting's SCHEMA is contributed by
  // sf-org-deploy-helper only — we read/watch it undeclared.
  reconcileOrgOnActivation(context.globalState, orgStore).catch(err =>
    output.appendLine(`Org sync reconcile failed: ${(err as Error).message}`)
  );

  context.subscriptions.push(
    output,
    // React to org changes made by a sibling family plugin via the shared
    // setting. The provider re-checks the sync flag at event time, so a change
    // arriving while sync is off is ignored without needing a reload.
    onSharedOrgChange(username => {
      provider.onSharedOrgChanged(username).catch(err =>
        output.appendLine(`Shared-org change handling failed: ${(err as Error).message}`)
      );
    }),
    // Turning sync ON adopts the family's current org right away — same path as
    // the watcher above, which also drops an empty shared value (no org to
    // adopt) and a value equal to ours. Turning sync off leaves the org alone.
    onOrgSyncEnabled(() => {
      provider.onSharedOrgChanged(getSharedOrg()).catch(err =>
        output.appendLine(`Org sync enable handling failed: ${(err as Error).message}`)
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
