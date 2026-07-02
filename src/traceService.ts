import { SfRestService } from './restClient';

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

  /** Force the next ensure() for `username` to re-verify (e.g. after org switch). */
  invalidate(username: string): void {
    this.ensuredUntil.delete(username);
  }

  /**
   * Ensure a DEVELOPER_LOG TraceFlag is active for `username`'s user. Returns a
   * short human status. Throws on hard failures (the caller surfaces it); a
   * recently-ensured org short-circuits. `usernameOfUser` is the org login the
   * TraceFlag should target — normally the same as the org username.
   */
  async ensureTraceFlag(username: string, usernameOfUser: string, timeoutMs?: number): Promise<string> {
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

    const debugLevelId = await this.getOrCreateDebugLevel(username, timeoutMs);
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

  private async getOrCreateDebugLevel(username: string, timeoutMs?: number): Promise<string> {
    const existing = await this.rest.toolingQuery<{ Id: string }>(
      username,
      `SELECT Id FROM DebugLevel WHERE DeveloperName = '${TraceService.DEBUG_LEVEL_NAME}'`,
      timeoutMs
    );
    if (existing.length > 0) return existing[0].Id;
    return this.rest.toolingCreate(username, 'DebugLevel', {
      MasterLabel: TraceService.DEBUG_LEVEL_NAME,
      DeveloperName: TraceService.DEBUG_LEVEL_NAME,
      ApexCode: 'DEBUG',
      ApexProfiling: 'INFO',
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
}
