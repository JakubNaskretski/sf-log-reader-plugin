import * as vscode from 'vscode';

const ORG_KEY = 'sfLogReader.selectedOrg.v1';
const USER_PREFIX = 'sfLogReader.selectedUser.v1.';

/** Set once this window has taken its single hop from the legacy machine-wide
 *  state. Lives with the store, i.e. per window — not per install. */
const PORTED_KEY = 'sfLogReader.orgPortedFromGlobal.v1';

/**
 * This plugin's own target org, plus the debug user picked for each org.
 *
 * Backed by `context.workspaceState`, so every VS Code window keeps its own org:
 * a second window opened on another project fetches ITS logs, not the org the
 * first window last picked. The per-org selected debug user deliberately moves
 * with the org into the same (per-window) memento — one store, one scope; the
 * cost is re-picking the debug user once per window.
 *
 * `globalState` is WRITTEN only for the once-per-install org-sync migration flag
 * (see orgSync.ts). It is also READ once per window, for the legacy
 * port-forward in `adoptLegacy` — a single stamped hop, never a standing
 * fallback.
 */
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

  /**
   * Port the pre-per-window state forward — at most ONE hop per window. Releases
   * before the per-window switch kept these keys in `globalState`, so on its
   * first activation a window with no org of its own adopts the legacy org —
   * along with every remembered debug user, so switching this window to another
   * org keeps that org's user too — instead of silently retargeting to the CLI
   * default (which may be production). The hop is then stamped in the window
   * store, whether or not there was anything to copy: without that stamp an org
   * cleared on purpose (logout, or a reconciliation dropping an org that is
   * gone) would be resurrected on every reload. State is written before the
   * stamp, so a crash in between simply re-ports next time. `legacyState` is
   * only ever READ: nothing is rewritten or deleted there, because the other
   * open windows still have to port it forward too. Per-window separation starts
   * at the next pick.
   */
  async adoptLegacy(legacyState: vscode.Memento): Promise<void> {
    if (this.memento.get<boolean>(PORTED_KEY)) return;
    // Read defensively: written by an older release and editable by hand.
    const legacy = this.getOrg() ? undefined : legacyState.get<unknown>(ORG_KEY);
    if (typeof legacy === 'string' && legacy.trim()) await this.setOrg(legacy.trim());
    // Users are ported on their own, not only alongside an org: an older build may
    // have dropped the org and kept its users, and a crash right after setOrg
    // must not strand them behind the stamp.
    for (const key of legacyState.keys()) {
      if (!key.startsWith(USER_PREFIX) || this.memento.get(key) !== undefined) continue;
      await this.memento.update(key, legacyState.get(key));
    }
    await this.memento.update(PORTED_KEY, true);
  }

}
