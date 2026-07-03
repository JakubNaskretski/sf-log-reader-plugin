import * as vscode from 'vscode';
import { SfRestService } from './restClient';

/** Which DebugLevel/TraceFlag preset to ensure. `'standard'` is today's
 *  default (unchanged byte-for-byte); `'profiling'` bumps ApexCode/ApexProfiling
 *  to FINEST so METHOD_ENTRY/METHOD_EXIT events show up for the Timeline view. */
export type TracePreset = 'standard' | 'profiling';

/**
 * Ensure a DEVELOPER_LOG TraceFlag exists for the current user so the org
 * actually writes debug logs — without it most users fetch zero logs.
 * Adapted from apex-editor's TraceService, but reusing the existing
 * SfRestService (its cached per-org session + single-refresh-on-401) instead of
 * a second raw https layer.
 *
 * The current user's Id is resolved from the org session (`sf org display` gives
 * the username; a `SELECT Id FROM User WHERE Username = …` maps it to the Id).
 */
export class TraceService {
  constructor(private readonly rest: SfRestService) {}

  /** Per-org "we've ensured a flag until this epoch-ms" cache so a re-invocation
   *  doesn't re-issue 2-3 Tooling calls needlessly. */
  private readonly ensuredUntil = new Map<string, number>();

  /** DebugLevel developer name we create/reuse. Own it so we never mutate a
   *  user's existing levels. */
  private static readonly DEBUG_LEVEL_NAME = 'SfLogReaderDefault';

  /** DebugLevel developer name for the profiling (FINEST) preset. A distinct
   *  name from DEBUG_LEVEL_NAME so both can coexist on the org. */
  private static readonly PROFILING_DEBUG_LEVEL_NAME = 'SfLogReaderDefault_Profiling';

  /** Force the next ensure() for `username` to re-verify (e.g. after org switch). */
  invalidate(username: string): void {
    this.ensuredUntil.delete(username);
  }

  /**
   * Ensure a DEVELOPER_LOG TraceFlag is active for `username`'s user. Returns a
   * short human status. Throws on hard failures (the caller surfaces it); a
   * recently-ensured org short-circuits. `usernameOfUser` is the org login the
   * TraceFlag should target — normally the same as the org username. `preset`
   * selects the DebugLevel: `'standard'` (default) is today's levels;
   * `'profiling'` uses a separate FINEST DebugLevel for the Timeline view.
   */
  async ensureTraceFlag(username: string, usernameOfUser: string, timeoutMs?: number, preset: TracePreset = 'standard'): Promise<string> {
    if ((this.ensuredUntil.get(username) ?? 0) > Date.now()) {
      return 'Debug logging already enabled.';
    }

    const userId = await this.resolveUserId(username, usernameOfUser, timeoutMs);
    if (!userId) {
      throw new Error(`Could not resolve the user Id for ${usernameOfUser} on the org.`);
    }

    const existing = await this.rest.toolingQuery<{ Id: string }>(
      username,
      `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG' AND ExpirationDate > TODAY`,
      timeoutMs
    );
    if (existing.length > 0) {
      // A flag already exists (expiry > TODAY). Re-verify in ~10 min rather than
      // re-querying every time, since we don't know its exact expiry here.
      this.ensuredUntil.set(username, Date.now() + 10 * 60 * 1000);
      return 'Debug logging already enabled.';
    }

    const debugLevelId = await this.getOrCreateDebugLevel(username, timeoutMs, preset);
    const now = new Date();
    const expiry = new Date(now.getTime() + 30 * 60 * 1000);
    await this.rest.toolingCreate(username, 'TraceFlag', {
      TracedEntityId: userId,
      DebugLevelId: debugLevelId,
      LogType: 'DEVELOPER_LOG',
      StartDate: now.toISOString(),
      ExpirationDate: expiry.toISOString()
    }, timeoutMs);
    // Cache until shortly before it expires so we re-ensure before the gap.
    this.ensuredUntil.set(username, expiry.getTime() - 5 * 60 * 1000);
    return `Debug logging enabled until ${expiry.toLocaleTimeString()} (30 min).`;
  }

  private async resolveUserId(username: string, usernameOfUser: string, timeoutMs?: number): Promise<string | undefined> {
    // Escape the username for the SOQL string literal — usernames can, in
    // principle, contain quotes/backslashes.
    const escaped = usernameOfUser.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const rows = await this.rest.toolingQuery<{ Id: string }>(
      username,
      `SELECT Id FROM User WHERE Username = '${escaped}'`,
      timeoutMs
    );
    return rows[0]?.Id;
  }

  private async getOrCreateDebugLevel(username: string, timeoutMs: number | undefined, preset: TracePreset): Promise<string> {
    const developerName = preset === 'profiling' ? TraceService.PROFILING_DEBUG_LEVEL_NAME : TraceService.DEBUG_LEVEL_NAME;
    const existing = await this.rest.toolingQuery<{ Id: string }>(
      username,
      `SELECT Id FROM DebugLevel WHERE DeveloperName = '${developerName}'`,
      timeoutMs
    );
    if (existing.length > 0) return existing[0].Id;
    return this.rest.toolingCreate(username, 'DebugLevel', {
      MasterLabel: developerName,
      DeveloperName: developerName,
      ApexCode: preset === 'profiling' ? 'FINEST' : 'DEBUG',
      ApexProfiling: preset === 'profiling' ? 'FINEST' : 'INFO',
      Callout: 'INFO',
      Database: 'INFO',
      System: 'DEBUG',
      Validation: 'INFO',
      Visualforce: 'INFO',
      Workflow: 'INFO',
      NBA: 'INFO',
      Wave: 'INFO'
    }, timeoutMs);
  }

  /**
   * Prompt the user to choose a TraceFlag preset via QuickPick, then ensure it.
   * Returns the `ensureTraceFlag` status message, or `undefined` if the user
   * cancels the picker (no TraceFlag change is made in that case).
   */
  async pickPresetAndEnsure(logUser: string, user: string, timeoutMs: number): Promise<string | undefined> {
    const items: Array<vscode.QuickPickItem & { preset: TracePreset }> = [
      { label: 'Standard', description: 'Current debug levels — smaller logs', preset: 'standard' },
      {
        label: 'Profiling (FINEST)',
        description: 'Method-level detail for the Timeline view — much larger logs, hits the 20 MB log cap sooner',
        preset: 'profiling'
      }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a debug logging preset' });
    if (!picked) return undefined;
    return this.ensureTraceFlag(logUser, user, timeoutMs, picked.preset);
  }
}
