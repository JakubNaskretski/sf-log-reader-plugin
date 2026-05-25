import * as vscode from 'vscode';
import { CommandTrail } from './commandTrail';
import { SfCliService } from './sfCliService';
import { OrgStore } from './orgStore';
import { LogReaderPanelProvider, migrateLegacyStorage } from './panelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Log Reader');
  const trail = new CommandTrail();
  const sf = new SfCliService(trail);
  const orgStore = new OrgStore(context.globalState);
  const provider = new LogReaderPanelProvider(context, sf, orgStore, trail, output);

  migrateLegacyStorage(context).catch(err => {
    output.appendLine(`Legacy storage migration failed: ${(err as Error).message}`);
  });

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(LogReaderPanelProvider.viewType, provider),
    vscode.commands.registerCommand('sfLogReader.refresh', () => provider.refreshStoredLogs()),
    vscode.commands.registerCommand('sfLogReader.fetchLatest', () => provider.fetchLatest()),
    vscode.commands.registerCommand('sfLogReader.selectOrg', () => provider.pickOrg()),
    vscode.commands.registerCommand('sfLogReader.selectUser', () => provider.pickUser()),
    vscode.commands.registerCommand('sfLogReader.openLogFolder', () => provider.openLogFolder()),
    vscode.commands.registerCommand('sfLogReader.clearLocalLogs', () => provider.clearLocalLogs()),
    vscode.commands.registerCommand('sfLogReader.generateSummary', async () => {
      const logId = await vscode.window.showInputBox({ prompt: 'ApexLog Id (07L…) to summarize' });
      const userId = await vscode.window.showInputBox({ prompt: 'LogUserId (005…) that owns the log' });
      if (logId && userId) await provider.generateSummaryFor(logId, userId);
    }),
    vscode.commands.registerCommand('sfLogReader.openLogFile', (uri?: vscode.Uri) => provider.openExternalLog(uri)),
    vscode.commands.registerCommand('sfLogReader.openSavedLogsFolder', () => provider.openSavedLogsFolder())
  );
}

export function deactivate(): void {
  // no-op
}
