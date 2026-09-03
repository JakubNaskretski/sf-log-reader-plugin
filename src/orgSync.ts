import * as vscode from 'vscode';
import { getSharedOrg, setSharedOrg } from './kit/orgs';

/**
 * Opt-in bridge between this plugin's OWN target org and the family-shared
 * setting (`skrety.salesforce.targetOrg`).
 *
 * The private OrgStore key is the source of truth: it is written on every
 * applied org change (user pick, follow-from-family, startup auto-select), and
 * the plugin always starts from it. The shared setting is only followed and
 * only published when `sfLogReader.syncOrgWithFamily` is ON (default OFF) — with
 * it off, switching orgs here never moves a sibling plugin and a switch made in
 * a sibling is ignored here.
 *
 * The flag is read at event time (never captured at registration) so toggling it
 * takes effect immediately, without a window reload.
 */

/** Setting section + name of the per-plugin opt-in. */
const CONFIG_SECTION = 'sfLogReader';
const SYNC_SETTING_NAME = 'syncOrgWithFamily';

/** Fully-qualified key, for `affectsConfiguration` checks. */
export const SYNC_SETTING = `${CONFIG_SECTION}.${SYNC_SETTING_NAME}`;

/**
 * globalState flag for the one-time private-key migration below. Versioned so a
 * future re-migration can use a new key.
 */
export const ORG_SYNC_MIGRATION_KEY = 'sfLogReader.orgSyncMigrated.v1';

/** The slice of OrgStore this module needs (keeps it trivially testable). */
export interface OrgMirror {
  getOrg(): string | undefined;
  setOrg(username: string | undefined): Promise<void>;
}

/** True when this plugin currently follows/publishes the family-shared org. */
export function isOrgSyncEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SYNC_SETTING_NAME, false) === true;
}

/**
 * Publish a USER-INITIATED org pick to the family-shared setting — and only
 * then. Activation, the shared-org watcher and the org-list reconciliation must
 * never reach this: with sync off the shared setting is not ours to touch, and
 * with sync on those paths are echoes of a value the family already has.
 */
export async function publishSharedOrg(username: string | undefined): Promise<void> {
  // Never publish an empty value: a "no org" pick must not blank the family.
  if (!username?.trim() || !isOrgSyncEnabled()) return;
  await setSharedOrg(username);
}

/**
 * Should an incoming family-shared org be adopted as ours? Only when
 *  - it is actually set: an EMPTY shared value is never adopted, by either the
 *    watcher or the toggle-on path — someone clearing the family org must not
 *    blank this plugin's working target;
 *  - sync is on, re-read here at event time so a toggle needs no reload;
 *  - it differs from what we already hold — a value we ourselves just published
 *    comes back through the watcher and must not trigger a redundant reload.
 */
export function shouldAdoptSharedOrg(username: string | undefined, privateValue: string | undefined): boolean {
  return !!username && isOrgSyncEnabled() && username !== privateValue;
}

/**
 * Activation-time reconciliation of the private key against the shared setting.
 *
 * (a) One-time migration, regardless of the sync flag: on the first activation
 *     after this feature ships, a set shared org is copied into the private key
 *     so the plugin keeps the org the family was actually on instead of falling
 *     back to a possibly long-stale private mirror. The globalState flag is then
 *     stamped UNCONDITIONALLY — even when the shared setting was empty and there
 *     was nothing to copy. Leaving it unstamped would arm the migration for some
 *     later activation, where a sync-off plugin would silently adopt whatever
 *     org a sibling had written in the meantime. It must run exactly once per
 *     install.
 * (b) Then, only when sync is ON, adopt a shared org that differs from ours.
 *
 * Nothing here writes the shared setting — the old "seed the empty shared
 * setting from our private mirror" step (and the `sf org list` validation that
 * kept it from resurrecting a dead org) is gone.
 */
export async function reconcileOrgOnActivation(memento: vscode.Memento, store: OrgMirror): Promise<void> {
  const shared = getSharedOrg();
  if (!memento.get<boolean>(ORG_SYNC_MIGRATION_KEY)) {
    if (shared && shared !== store.getOrg()) await store.setOrg(shared);
    await memento.update(ORG_SYNC_MIGRATION_KEY, true);
    return;
  }
  if (isOrgSyncEnabled() && shared && shared !== store.getOrg()) {
    await store.setOrg(shared);
  }
}

/**
 * Fire `handler` when `sfLogReader.syncOrgWithFamily` is switched ON, so the
 * plugin can adopt the shared org straight away (same path as the shared-org
 * watcher). Switching it OFF deliberately does nothing — the org in use stays.
 */
export function onOrgSyncEnabled(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SYNC_SETTING) && isOrgSyncEnabled()) handler();
  });
}
