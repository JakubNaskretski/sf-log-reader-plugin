import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORG_SYNC_MIGRATION_KEY,
  SYNC_SETTING,
  isOrgSyncEnabled,
  onOrgSyncEnabled,
  publishSharedOrg,
  reconcileOrgOnActivation,
  shouldAdoptSharedOrg
} from './orgSync';
import { LogReaderPanelProvider } from './panelProvider';
import { OrgStore } from './orgStore';

/**
 * orgSync.ts (and the kit helpers it calls) read/write VS Code settings. There's
 * no real 'vscode' package under test — VS Code injects it as a virtual module
 * at runtime — so this stubs a tiny settings store: `getConfiguration(section)`
 * hands back get/update bound to the fully-qualified key, exactly like the real
 * API. vi.mock is hoisted above the imports, so it applies before orgSync loads.
 */
const settings = new Map<string, unknown>();
const configListeners: Array<(e: { affectsConfiguration(key: string): boolean }) => void> = [];

vi.mock('vscode', () => {
  const qualify = (section: string | undefined, key: string): string => (section ? `${section}.${key}` : key);
  return {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: (section?: string) => ({
        get: (key: string, fallback?: unknown) => {
          const full = qualify(section, key);
          return settings.has(full) ? settings.get(full) : fallback;
        },
        update: async (key: string, value: unknown) => {
          const full = qualify(section, key);
          if (value === undefined) settings.delete(full);
          else settings.set(full, value);
        }
      }),
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration(key: string): boolean }) => void) => {
        configListeners.push(listener);
        return { dispose: () => { /* not exercised */ } };
      }
    }
  };
});

const SHARED = 'skrety.salesforce.targetOrg';

/** What a pre-per-window release left behind in globalState. */
const LEGACY_ORG = 'legacy@acme.example';
const LEGACY_ORG_KEY = 'sfLogReader.selectedOrg.v1';
const LEGACY_USER = '005fictional';
const LEGACY_USER_KEY = `sfLogReader.selectedUser.v1.${LEGACY_ORG}`;
const LEGACY_OTHER_USER_KEY = 'sfLogReader.selectedUser.v1.qa@acme.example';
const PORTED_KEY = 'sfLogReader.orgPortedFromGlobal.v1';

/** Fire a settings-changed event for `key`, like VS Code would. */
function fireConfigChange(key: string): void {
  for (const l of configListeners) l({ affectsConfiguration: (k: string) => k === key });
}

function setSync(on: boolean): void {
  settings.set(SYNC_SETTING, on);
}

/** Minimal stand-in for the workspaceState-backed OrgStore. */
class FakeStore {
  constructor(private org: string | undefined = undefined) {}
  getOrg(): string | undefined { return this.org; }
  async setOrg(username: string | undefined): Promise<void> { this.org = username; }
  /** Legacy port-forward: exercised against the real OrgStore in 'per-window scope'. */
  async adoptLegacy(): Promise<void> { /* nothing to port in these fixtures */ }
}

/** Minimal stand-in for a VS Code memento (workspaceState or globalState). */
class FakeMemento {
  readonly values = new Map<string, unknown>();
  /** Keys this memento was WRITTEN to (reads are not recorded). */
  readonly writes: string[] = [];
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    this.writes.push(key);
    this.values.set(key, value);
  }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

beforeEach(() => {
  settings.clear();
  configListeners.length = 0;
});

describe('isOrgSyncEnabled', () => {
  it('defaults to off when the setting was never touched', () => {
    expect(isOrgSyncEnabled()).toBe(false);
  });
});

describe('sync OFF', () => {
  it('a user pick writes the private org but never the shared setting', async () => {
    const store = new FakeStore();
    await store.setOrg('dev@acme.example');
    await publishSharedOrg('dev@acme.example');
    expect(store.getOrg()).toBe('dev@acme.example');
    expect(settings.has(SHARED)).toBe(false);
  });

  it('ignores a shared-org change from a sibling plugin', () => {
    expect(shouldAdoptSharedOrg('qa@acme.example', 'dev@acme.example')).toBe(false);
  });
});

describe('sync ON', () => {
  beforeEach(() => setSync(true));

  it('a user pick publishes to the shared setting', async () => {
    await publishSharedOrg('dev@acme.example');
    expect(settings.get(SHARED)).toBe('dev@acme.example');
  });

  it('never publishes an empty pick — a "no org" choice must not blank the family', async () => {
    settings.set(SHARED, 'dev@acme.example');
    await publishSharedOrg(undefined);
    await publishSharedOrg('');
    await publishSharedOrg('   ');
    expect(settings.get(SHARED)).toBe('dev@acme.example');
  });

  it('adopts a differing shared org, and skips the echo of our own write', () => {
    expect(shouldAdoptSharedOrg('qa@acme.example', 'dev@acme.example')).toBe(true);
    expect(shouldAdoptSharedOrg('dev@acme.example', 'dev@acme.example')).toBe(false);
  });

  it('never adopts an empty shared value — clearing the family org keeps ours', () => {
    expect(shouldAdoptSharedOrg(undefined, 'dev@acme.example')).toBe(false);
    expect(shouldAdoptSharedOrg('', 'dev@acme.example')).toBe(false);
  });

  it('re-reads the flag per event, so turning sync off takes effect with no reload', () => {
    setSync(false);
    expect(shouldAdoptSharedOrg('qa@acme.example', 'dev@acme.example')).toBe(false);
  });
});

describe('reconcileOrgOnActivation', () => {
  it('migrates the shared org into the private key once, then no-ops (sync off)', async () => {
    settings.set(SHARED, 'dev@acme.example');
    const memento = new FakeMemento();
    const store = new FakeStore('stale@acme.example');

    await reconcileOrgOnActivation(memento, store);
    expect(store.getOrg()).toBe('dev@acme.example');
    expect(memento.get(ORG_SYNC_MIGRATION_KEY)).toBe(true);

    // A later family switch must not reach us again while sync is off.
    settings.set(SHARED, 'qa@acme.example');
    await reconcileOrgOnActivation(memento, store);
    expect(store.getOrg()).toBe('dev@acme.example');
  });

  it('stamps the migration flag even when the shared setting is empty', async () => {
    const memento = new FakeMemento();
    const store = new FakeStore('dev@acme.example');

    await reconcileOrgOnActivation(memento, store);
    expect(store.getOrg()).toBe('dev@acme.example');
    expect(memento.get(ORG_SYNC_MIGRATION_KEY)).toBe(true);
  });

  it('does not adopt on a later activation once a sibling sets the shared org (sync off)', async () => {
    // First activation: nothing shared yet, so nothing to migrate — but the flag
    // is stamped, which is what keeps the migration from firing later.
    const memento = new FakeMemento();
    const store = new FakeStore('dev@acme.example');
    await reconcileOrgOnActivation(memento, store);

    settings.set(SHARED, 'qa@acme.example');
    await reconcileOrgOnActivation(memento, store);
    expect(store.getOrg()).toBe('dev@acme.example');
  });

  it('adopts the shared org on activation once sync is on', async () => {
    settings.set(SHARED, 'qa@acme.example');
    setSync(true);
    const memento = new FakeMemento();
    memento.values.set(ORG_SYNC_MIGRATION_KEY, true); // migration already done
    const store = new FakeStore('dev@acme.example');

    await reconcileOrgOnActivation(memento, store);
    expect(store.getOrg()).toBe('qa@acme.example');
  });

  it('never writes the shared setting (the old reseed is gone)', async () => {
    const memento = new FakeMemento();
    const store = new FakeStore('dev@acme.example');
    await reconcileOrgOnActivation(memento, store);
    expect(settings.has(SHARED)).toBe(false);
    expect(store.getOrg()).toBe('dev@acme.example');
  });
});

describe('panel provider: shared org cleared while sync is ON', () => {
  it('leaves the private org and the loaded user list untouched', async () => {
    setSync(true);
    settings.delete(SHARED);
    const store = new FakeStore('dev@acme.example');
    const users = [{ Id: '005user', Name: 'Ada Fictional', Username: 'dev@acme.example' }];
    const provider = new LogReaderPanelProvider(
      { globalState: new FakeMemento(), extensionUri: {}, globalStorageUri: { fsPath: '/tmp/none' } } as never,
      {} as never,
      {} as never,
      store as never,
      { onChange: () => undefined } as never,
      { appendLine: () => undefined } as never
    );
    (provider as unknown as { users: unknown[] }).users = users;

    // The watcher hands us the cleared value; it must be a no-op — no store
    // write, no user-list wipe, no `sf org list` (the fakes above would throw).
    await provider.onSharedOrgChanged(undefined);

    expect(store.getOrg()).toBe('dev@acme.example');
    expect((provider as unknown as { users: unknown[] }).users).toEqual(users);
  });
});

describe('onOrgSyncEnabled', () => {
  it('fires when the toggle flips on, and not when it flips off', () => {
    const handler = vi.fn();
    onOrgSyncEnabled(handler);

    setSync(true);
    fireConfigChange(SYNC_SETTING);
    expect(handler).toHaveBeenCalledTimes(1);

    setSync(false);
    fireConfigChange(SYNC_SETTING);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to unrelated settings', () => {
    const handler = vi.fn();
    onOrgSyncEnabled(handler);
    setSync(true);
    fireConfigChange('sfLogReader.fetchLimit');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('per-window scope', () => {
  it('ports the legacy org and every remembered debug user forward once, then keeps both per window', async () => {
    // Upgrade from a pre-per-window release: this window has no org yet, so it
    // adopts the org globalState still holds — and the debug user remembered for
    // it — instead of silently retargeting to the CLI default org.
    const workspaceState = new FakeMemento();
    const globalState = new FakeMemento();
    globalState.values.set(LEGACY_ORG_KEY, LEGACY_ORG);
    globalState.values.set(LEGACY_USER_KEY, LEGACY_USER);
    globalState.values.set(LEGACY_OTHER_USER_KEY, '005other');
    const store = new OrgStore(workspaceState as never);

    await reconcileOrgOnActivation(globalState as never, store);

    expect(store.getOrg()).toBe(LEGACY_ORG);
    expect(store.getUser(LEGACY_ORG)).toBe(LEGACY_USER);
    // Every remembered debug user comes along, not just the ported org's, so
    // switching this window to another org keeps that org's user too.
    expect(store.getUser('qa@acme.example')).toBe('005other');

    // All of it must be WRITTEN to the window store: reads that just fell back
    // to globalState would leave this window empty.
    expect(workspaceState.values.get(LEGACY_ORG_KEY)).toBe(LEGACY_ORG);
    expect(workspaceState.values.get(LEGACY_USER_KEY)).toBe(LEGACY_USER);
    expect(workspaceState.values.get(LEGACY_OTHER_USER_KEY)).toBe('005other');

    // The legacy values are read-only — other open windows still have to port
    // them forward — so the flag is the only machine-wide write.
    expect(globalState.writes).toEqual([ORG_SYNC_MIGRATION_KEY]);
    expect(workspaceState.keys()).not.toContain(ORG_SYNC_MIGRATION_KEY);

    // A pick in this window stays in this window.
    await store.setOrg('dev@acme.example');
    expect(globalState.values.get(LEGACY_ORG_KEY)).toBe(LEGACY_ORG);

    // Clearing the org empties THIS window; the machine-wide leftover must not
    // resurface as a read fallback.
    await store.setOrg(undefined);
    expect(store.getOrg()).toBeUndefined();

    // The hop is stamped in THIS window's store, so it happens at most once: an
    // org cleared on purpose (logout, or a reconciliation dropping an org that
    // is gone) must not be resurrected by the next activation.
    expect(workspaceState.values.get(PORTED_KEY)).toBe(true);
    expect(globalState.values.has(PORTED_KEY)).toBe(false);
    await reconcileOrgOnActivation(globalState as never, store);
    expect(store.getOrg()).toBeUndefined();

    // A window with nothing to port stamps itself all the same — the stamp is
    // what makes the hop one-per-window rather than one-per-activation.
    const freshWindow = new FakeMemento();
    const freshGlobal = new FakeMemento();
    await reconcileOrgOnActivation(freshGlobal as never, new OrgStore(freshWindow as never));
    expect(freshWindow.values.get(PORTED_KEY)).toBe(true);
    expect(freshGlobal.values.has(PORTED_KEY)).toBe(false);

    // A second window that already has its own org keeps it.

    const otherWindow = new FakeMemento();
    otherWindow.values.set(LEGACY_ORG_KEY, 'qa@acme.example');
    const otherStore = new OrgStore(otherWindow as never);
    await reconcileOrgOnActivation(globalState as never, otherStore);
    expect(otherStore.getOrg()).toBe('qa@acme.example');
    expect(globalState.values.get(LEGACY_ORG_KEY)).toBe(LEGACY_ORG);
  });

  it('lets the once-per-install migration win over the ported legacy org', async () => {
    // Ordering: the port-forward runs first, the one-time shared → private
    // migration on top of it, so a first activation with both pending ends on
    // the family's org exactly as it did before the port-forward existed.
    settings.set(SHARED, 'dev@acme.example');
    const workspaceState = new FakeMemento();
    const globalState = new FakeMemento();
    globalState.values.set(LEGACY_ORG_KEY, LEGACY_ORG);
    const store = new OrgStore(workspaceState as never);

    await reconcileOrgOnActivation(globalState as never, store);

    expect(store.getOrg()).toBe('dev@acme.example');
    expect(workspaceState.values.get(PORTED_KEY)).toBe(true);
    expect(globalState.values.get(ORG_SYNC_MIGRATION_KEY)).toBe(true);
    expect(globalState.values.get(LEGACY_ORG_KEY)).toBe(LEGACY_ORG);
  });
});

describe('extension wiring', () => {
  // Source pins: a swapped memento pair compiles and passes every unit test
  // while silently making the org machine-wide again.
  const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

  it('builds the org store on workspaceState and keeps the migration flag on globalState', () => {
    expect(source).toContain('new OrgStore(context.workspaceState)');
    expect(source).toContain('reconcileOrgOnActivation(context.globalState, orgStore)');
  });

  it('never constructs the OrgStore on globalState', () => {
    expect(
      source.includes('new OrgStore(context.globalState'),
      'src/extension.ts must construct new OrgStore(context.workspaceState): a globalState-backed store shares the org and its debug user with every other VS Code window'
    ).toBe(false);
  });
});
