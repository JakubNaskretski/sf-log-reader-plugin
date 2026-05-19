import { spawn } from 'child_process';
import { CommandTrail } from './commandTrail';

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

interface RunOptions {
  timeoutMs?: number;
  note?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class SfCliService {
  private readonly defaultTimeoutMs = 60_000;

  constructor(private readonly trail: CommandTrail) {}

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

  async listLogs(targetOrg: string, limit: number, timeoutMs?: number): Promise<ApexLogRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const query =
      `SELECT Id, Application, DurationMilliseconds, Location, LogLength, LogUserId, LogUser.Name, ` +
      `Operation, Request, StartTime, Status FROM ApexLog ORDER BY StartTime DESC LIMIT ${safeLimit}`;
    const json = await this.runJson<{
      result: { records?: Array<Record<string, unknown>> };
    }>(
      ['data', 'query', '--query', query, '--use-tooling-api', '--target-org', targetOrg, '--json'],
      { timeoutMs, note: `list ${safeLimit} logs` }
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
    return extractLogBody(json.result);
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
    const { stdout, stderr, code } = await this.run(args, options);
    if (code !== 0 && !stdout) {
      throw new SfCliError(`sf ${args.join(' ')} exited with code ${code}`, stderr);
    }
    try {
      return JSON.parse(stdout) as T;
    } catch (err) {
      throw new SfCliError(`Failed to parse JSON from sf ${args.join(' ')}`, stderr, err);
    }
  }

  private run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn('sf', args, { shell: false });
      const finish = (code: number, killed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        this.trail.record({
          startedAt,
          durationMs,
          cmd: 'sf',
          args,
          exitCode: code,
          ok: !killed && code === 0,
          stderrSnippet: stderr ? truncate(stderr, 400) : undefined,
          note: killed ? `${options.note ?? ''} (timeout)`.trim() : options.note
        });
        resolve({ stdout, stderr, code });
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(-1, true);
      }, timeoutMs);

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => {
        stderr += `\n${(err as Error).message}`;
        finish(-1, false);
      });
      child.on('close', code => finish(code ?? -1, false));
    });
  }
}

function normalizeLogRecord(raw: Record<string, unknown>): ApexLogRecord {
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

function extractLogBody(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    if (result.length === 0) return '';
    const first = result[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'log' in first) {
      return String((first as { log?: unknown }).log ?? '');
    }
  }
  if (result && typeof result === 'object' && 'log' in (result as object)) {
    return String((result as { log?: unknown }).log ?? '');
  }
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
