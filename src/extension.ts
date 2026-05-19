import * as vscode from 'vscode';
import { CommandTrail } from './commandTrail';
import { SfCliService } from './sfCliService';
import { OrgStore } from './orgStore';
import { LogReaderPanelProvider } from './panelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SF Log Reader');
  const trail = new CommandTrail();
  const sf = new SfCliService(trail);
  const orgStore = new OrgStore(context.globalState);
  const provider = new LogReaderPanelProvider(context, sf, orgStore, trail, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(LogReaderPanelProvider.viewType, provider),
    vscode.commands.registerCommand('sfLogReader.refresh', () => provider.refreshStoredLogs()),
    vscode.commands.registerCommand('sfLogReader.fetchLatest', () => provider.fetchLatest()),
    vscode.commands.registerCommand('sfLogReader.selectOrg', () => provider.pickOrg()),
    vscode.commands.registerCommand('sfLogReader.selectUser', () => provider.pickUser()),
    vscode.commands.registerCommand('sfLogReader.openLogFolder', () => provider.openLogFolder()),
    vscode.commands.registerCommand('sfLogReader.clearLocalLogs', () => provider.clearLocalLogs())
  );
}

export function deactivate(): void {
  // no-op
}
