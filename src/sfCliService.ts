import { spawn } from 'child_process';
import { CommandTrail } from './commandTrail';
import { resolveSfCommand } from './kit/sfCli';

export interface OrgInfo {
  username: string;
  alias?: string;
  orgId: string;
  instanceUrl: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  connectedStatus?: string;
}

export interface ApexLogRecord {
  Id: string;
  Application?: string;
  DurationMilliseconds?: number;
  Location?: string;
  LogLength?: number;
  LogUserId?: string;
  LogUserName?: string;
  Operation?: string;
  Request?: string;
  StartTime?: string;
  Status?: string;
}

export interface UserRecord {
  Id: string;
  Name: string;
  Username?: string;
}

export class SfCliError extends Error {
  constructor(message: string, public readonly stderr?: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SfCliError';
  }
}

/** Credentials for direct REST calls. Held in memory only — never logged or persisted. */
export interface OrgConnection {
  instanceUrl: string;
  accessToken: string;
  apiVersion: string;
}

interface RunOptions {
  timeoutMs?: number;
  note?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when the CLI could not be launched at all (spawn ENOENT). Set only
   *  from the spawn `error` event — never inferred from stderr contents, which
   *  sf plugins print ENOENT warnings into on a perfectly successful exit 0. */
  notFound?: boolean;
}

export class SfCliService {
  private readonly defaultTimeoutMs = 60_000;
  /** Resolved absolute `sf` launcher path (Windows shim) — computed once. */
  private resolvedSf: string | undefined;

  constructor(private readonly trail: CommandTrail) {}

  /** Cache the resolved `sf` launcher path so we pay the Windows lookup once. */
  private sfCommand(): string {
    if (this.resolvedSf === undefined) this.resolvedSf = resolveSfCommand();
    return this.resolvedSf;
  }

  async listOrgs(timeoutMs?: number): Promise<OrgInfo[]> {
    const result = await this.runJson<{
      result: {
        nonScratchOrgs?: OrgInfo[];
        scratchOrgs?: OrgInfo[];
        sandboxes?: OrgInfo[];
        other?: OrgInfo[];
      };
    }>(['org', 'list', '--json'], { timeoutMs, note: 'list orgs' });

    const buckets = result.result ?? {};
    const all = [
      ...(buckets.nonScratchOrgs ?? []),
      ...(buckets.scratchOrgs ?? []),
      ...(buckets.sandboxes ?? []),
      ...(buckets.other ?? [])
    ];

    const seen = new Set<string>();
    return all.filter(org => {
      if (!org?.username || seen.has(org.username)) return false;
      seen.add(org.username);
      return true;
    });
  }

  async listLogs(targetOrg: string, limit: number, timeoutMs?: number, userId?: string): Promise<ApexLogRecord[]> {
    const query = apexLogQuery(limit, userId);
    const json = await this.runJson<{
      result: { records?: Array<Record<string, unknown>> };
    }>(
      ['data', 'query', '--query', query, '--use-tooling-api', '--target-org', targetOrg, '--json'],
      { timeoutMs, note: 'list logs' }
    );
    const records = json.result?.records ?? [];
    return records.map(r => normalizeLogRecord(r));
  }

  async getLogBody(targetOrg: string, logId: string, timeoutMs?: number): Promise<string> {
    const json = await this.runJson<{
      result?: unknown;
    }>(
      ['apex', 'get', 'log', '-i', logId, '--target-org', targetOrg, '--json'],
      { timeoutMs, note: `get log ${logId}` }
    );
    const body = extractLogBody(json.result);
    // An ApexLog body is never empty; an empty string means the CLI returned an
    // unexpected shape — fail loudly instead of saving a 0-byte log as a success.
    if (!body) {
      throw new SfCliError(`Empty log body returned for ${logId}`);
    }
    return body;
  }

  /**
   * Resolve the org's live session for direct REST calls. The token is returned
   * to the caller only — it must never reach the command trail, output channel,
   * error messages, or disk.
   */
  async orgDisplay(targetOrg: string, timeoutMs?: number): Promise<OrgConnection> {
    const json = await this.runJson<{
      result?: { accessToken?: unknown; instanceUrl?: unknown; apiVersion?: unknown };
    }>(
      ['org', 'display', '--target-org', targetOrg, '--json'],
      { timeoutMs, note: 'resolve REST session' }
    );
    const r = json.result ?? {};
    const accessToken = typeof r.accessToken === 'string' ? r.accessToken : '';
    const instanceUrl = typeof r.instanceUrl === 'string' ? r.instanceUrl.replace(/\/+$/, '') : '';
    if (!accessToken || !instanceUrl) {
      throw new SfCliError(`sf org display returned no usable session for ${targetOrg}`);
    }
    return { accessToken, instanceUrl, apiVersion: normalizeApiVersion(r.apiVersion) };
  }

  async listActiveUsers(targetOrg: string, timeoutMs?: number): Promise<UserRecord[]> {
    const query = `SELECT Id, Name, Username FROM User WHERE IsActive = true ORDER BY Name LIMIT 200`;
    const json = await this.runJson<{
      result: { records?: UserRecord[] };
    }>(
      ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
      { timeoutMs, note: 'list active users' }
    );
    return json.result?.records ?? [];
  }

  private async runJson<T>(args: string[], options: RunOptions = {}): Promise<T> {
    const { stdout, stderr, code, notFound } = await this.run(args, options);
    // Failed to even launch the CLI (not installed / not on PATH). Inferred ONLY
    // from a spawn ENOENT (notFound), never from stderr contents — sf plugins
    // print ENOENT warnings on a valid exit 0, which the old stderr-substring
    // check misfired on. The Windows shell path that made
    // cmd.exe emit "is not recognized…" is gone too: we now resolve the real
    // sf.cmd shim path and spawn it with shell:false (kit resolveSfCommand).
    if (notFound) {
      throw new SfCliError('Salesforce CLI (sf) not found on PATH. Install it and reload VS Code.', stderr);
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new SfCliError(`sf ${args.join(' ')} produced no output (exit ${code})`, stderr);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new SfCliError(`Failed to parse JSON from sf ${args.join(' ')}`, stderr, err);
    }
    // `sf --json` writes an error envelope ({status!=0, message/name}) to stdout even
    // on failure — surface it instead of returning it as a success result.
    const env = parsed as { status?: number; message?: unknown; name?: unknown };
    if (env && typeof env.status === 'number' && env.status !== 0) {
      const msg = (typeof env.message === 'string' && env.message) || (typeof env.name === 'string' && env.name) || `sf ${args.join(' ')} failed (status ${env.status})`;
      throw new SfCliError(String(msg), stderr);
    }
    if (code !== 0 && (!env || env.status === undefined)) {
      throw new SfCliError(`sf ${args.join(' ')} exited with code ${code}`, stderr);
    }
    return parsed as T;
  }

  private run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      // Collect raw Buffers and decode once, so multi-byte UTF-8 sequences split
      // across stream chunks (common in large logs) aren't corrupted.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let notFound = false;

      // Resolve the sf launcher once (kit shim-resolution): on Windows the real
      // launcher is `sf.cmd`/`sf.ps1`, which Node refuses to spawn as the bare
      // name (EINVAL since the CVE-2024-27980 hardening). We spawn the resolved
      // absolute path with shell:false — no shell, so args pass through as an
      // argv array verbatim with NO cmd.exe quoting needed (retiring the old
      // shell:true + quoteForCmd path and its `%`-expansion gap).
      const child = spawn(this.sfCommand(), args, { shell: false });
      const finish = (code: number, killed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const durationMs = Date.now() - startedAt;
        this.trail.record({
          startedAt,
          durationMs,
          cmd: 'sf',
          args,
          exitCode: code,
          ok: !killed && !notFound && code === 0,
          stderrSnippet: stderr ? truncate(stderr, 400) : undefined,
          note: killed ? `${options.note ?? ''} (timeout)`.trim() : options.note
        });
        resolve({ stdout, stderr, code, notFound });
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(-1, true);
      }, timeoutMs);

      child.stdout.on('data', chunk => { stdoutChunks.push(Buffer.from(chunk)); });
      child.stderr.on('data', chunk => { stderrChunks.push(Buffer.from(chunk)); });
      child.on('error', err => {
        // "sf not found" is inferred ONLY here, from a spawn ENOENT — never from
        // stderr contents.
        notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        stderrChunks.push(Buffer.from(`\n${(err as Error).message}`));
        finish(-1, false);
      });
      child.on('close', code => finish(code ?? -1, false));
    });
  }
}

/** A valid Salesforce record id (15 or 18 char, alphanumeric). Used to gate a
 *  LogUserId before it enters a SOQL string that reaches a REST URL (and, on the
 *  CLI path, the process argv). Exported for tests. */
export const SF_ID_RE = /^[A-Za-z0-9]{15,18}$/;

/** True when `id` is a syntactically valid Salesforce id (15/18 alphanumeric). */
export function isValidSalesforceId(id: string | undefined | null): id is string {
  return typeof id === 'string' && SF_ID_RE.test(id);
}

/**
 * SOQL for the newest ApexLog headers — shared by the CLI and REST list paths.
 * When `userId` is a valid Salesforce id, the query is filtered server-side with
 * `WHERE LogUserId = '<id>'` so busy orgs don't return top-N logs that all get
 * client-filtered away. The id is validated (`SF_ID_RE`) before
 * interpolation — it enters a REST URL and the CLI argv — and an invalid one is
 * ignored (no WHERE clause) rather than trusted.
 */
export function apexLogQuery(limit: number, userId?: string): string {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const where = isValidSalesforceId(userId) ? ` WHERE LogUserId = '${userId}'` : '';
  return (
    `SELECT Id, Application, DurationMilliseconds, Location, LogLength, LogUserId, LogUser.Name, ` +
    `Operation, Request, StartTime, Status FROM ApexLog${where} ORDER BY StartTime DESC LIMIT ${safeLimit}`
  );
}

export function normalizeApiVersion(value: unknown): string {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
    return value.includes('.') ? value : `${value}.0`;
  }
  // Old enough that any current org supports it, new enough for the Tooling API.
  return '61.0';
}

export function normalizeLogRecord(raw: Record<string, unknown>): ApexLogRecord {
  const logUser = (raw['LogUser'] ?? {}) as Record<string, unknown>;
  return {
    Id: String(raw['Id'] ?? ''),
    Application: optionalString(raw['Application']),
    DurationMilliseconds: optionalNumber(raw['DurationMilliseconds']),
    Location: optionalString(raw['Location']),
    LogLength: optionalNumber(raw['LogLength']),
    LogUserId: optionalString(raw['LogUserId']),
    LogUserName: optionalString(logUser['Name']),
    Operation: optionalString(raw['Operation']),
    Request: optionalString(raw['Request']),
    StartTime: optionalString(raw['StartTime']),
    Status: optionalString(raw['Status'])
  };
}

/**
 * Pull the log text out of `sf apex get log --json`'s `result`, which can be a
 * string, an array of strings, or an array/object of `{ log }` — and on the
 * Tooling-API-backed path, PascalCase `{ Log }`. Exported for tests.
 */
export function extractLogBody(result: unknown): string {
  const pick = (o: Record<string, unknown>): string => String(o['log'] ?? o['Log'] ?? '');
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    if (result.length === 0) return '';
    const first = result[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return pick(first as Record<string, unknown>);
  }
  if (result && typeof result === 'object') return pick(result as Record<string, unknown>);
  return '';
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `…(${value.length - max} more chars)`;
}
