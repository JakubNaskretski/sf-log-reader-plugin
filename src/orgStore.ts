import * as vscode from 'vscode';

const ORG_KEY = 'sfLogReader.selectedOrg.v1';
const USER_PREFIX = 'sfLogReader.selectedUser.v1.';

export class OrgStore {
  constructor(private readonly memento: vscode.Memento) {}

  getOrg(): string | undefined {
    return this.memento.get<string>(ORG_KEY);
  }

  async setOrg(username: string | undefined): Promise<void> {
    await this.memento.update(ORG_KEY, username);
  }

  getUser(orgUsername: string): string | undefined {
    return this.memento.get<string>(USER_PREFIX + orgUsername);
  }

  async setUser(orgUsername: string, userId: string | undefined): Promise<void> {
    await this.memento.update(USER_PREFIX + orgUsername, userId);
  }
}
