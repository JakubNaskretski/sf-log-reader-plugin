import * as vscode from 'vscode';
import { CommandTrail } from './commandTrail';
import { SfCliService, normalizeApiVersion } from './sfCliService';
import { SfRestService } from './restClient';
import { OrgStore } from './orgStore';
import { LogReaderPanelProvider, migrateLegacyStorage } from './panelProvider';
import { getSharedOrg, migrateToSharedOrg, onSharedOrgChange } from './kit/orgs';

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
  // private key (no-ops once the shared setting is populated). Validates the
  // private mirror against a live org list first so a stale one isn't resurrected
  // into the family's shared setting. The setting SCHEMA is contributed by
  // sf-org-deploy-helper only — we read/write it undeclared.
  seedSharedOrg(sf, orgStore, output).catch(err =>
    output.appendLine(`Shared-org seed failed: ${(err as Error).message}`)
  );

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

/**
 * Seed the shared cross-plugin org from this plugin's private mirror without ever
 * resurrecting a stale one. migrateToSharedOrg writes the private key into an
 * EMPTY shared setting unconditionally — so if the shared setting was cleared
 * (e.g. its org was deauthenticated) while this plugin wasn't running, a
 * long-gone mirror would be pushed back onto the whole family. Before seeding a
 * non-empty mirror into an empty shared setting, validate it against a fresh
 * `sf org list` (the safe --skip-connection-status flag, no wipe risk); when the
 * org is gone, skip the seed and clear the private mirror instead so the next
 * activation doesn't retry the resurrection. Otherwise behaviour is the plain
 * migrate-then-adopt (shared already set, or the mirror validates).
 */
async function seedSharedOrg(sf: SfCliService, orgStore: OrgStore, output: vscode.OutputChannel): Promise<void> {
  const privateValue = orgStore.getOrg();
  // Only the empty-shared + non-empty-mirror case can resurrect a stale org;
  // otherwise migrateToSharedOrg already no-ops (shared populated) or has nothing
  // to seed. Validate just that case so we don't spawn `sf org list` needlessly.
  if (!getSharedOrg() && privateValue && privateValue.trim()) {
    const orgs = await sf.listOrgs();
    if (!orgs.some(o => o.username === privateValue)) {
      await orgStore.setOrg(undefined);
      output.appendLine(`Shared-org seed skipped: private org ${privateValue} is no longer authenticated; cleared the stale mirror.`);
      return;
    }
  }
  const effective = await migrateToSharedOrg(privateValue);
  if (effective && effective !== orgStore.getOrg()) await orgStore.setOrg(effective);
}

export function deactivate(): void {
  // no-op
}
