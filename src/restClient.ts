import { CommandTrail } from './commandTrail';
import { ApexLogRecord, OrgConnection, SfCliError, apexLogQuery, normalizeLogRecord } from './sfCliService';

/**
 * Minimal structural view of fetch/Response so tests can stub the transport
 * and the extension host's global fetch satisfies it unmodified.
 */
export interface RestResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<RestResponse>;

export interface SessionProvider {
  orgDisplay(targetOrg: string, timeoutMs?: number): Promise<OrgConnection>;
}

interface CacheEntry {
  promise: Promise<OrgConnection>;
  failed: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Direct Salesforce REST access for the hot paths (log list + log bodies),
 * avoiding the ~1-3s `sf` CLI process startup per call. The session comes from
 * one `sf org display` per org and lives in memory only: the access token must
 * never be logged, recorded in the command trail, included in error messages,
 * or written to disk.
 */
export class SfRestService {
  private readonly connections = new Map<string, CacheEntry>();

  constructor(
    private readonly session: SessionProvider,
    private readonly trail: CommandTrail,
    private readonly fetchFn: FetchLike | undefined = (globalThis as { fetch?: FetchLike }).fetch,
    /** Explicit `sfLogReader.apiVersion` override; undefined = use the org's version. */
    private readonly apiVersionOverride: () => string | undefined = () => undefined
  ) {}

  /** False on runtimes without global fetch — callers then use the CLI path. */
  available(): boolean {
    return typeof this.fetchFn === 'function';
  }

  /**
   * Drop a cached session that ended in failure so the next fetch retries REST.
   * Successful sessions are kept — reusing the token is the whole speed win.
   */
  resetIfFailed(username: string): void {
    if (this.connections.get(username)?.failed) {
      this.connections.delete(username);
    }
  }

  invalidate(username: string): void {
    this.connections.delete(username);
  }

  async queryLogs(username: string, limit: number, timeoutMs?: number, userId?: string): Promise<ApexLogRecord[]> {
    const startedAt = Date.now();
    const soql = apexLogQuery(limit, userId);
    const raw = await this.request(
      username,
      conn => `${conn.instanceUrl}/services/data/v${conn.apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
      { timeoutMs }
    );
    this.trail.record({
      startedAt,
      durationMs: Date.now() - startedAt,
      cmd: 'REST',
      args: ['GET', 'tooling/query ApexLog'],
      exitCode: 0,
      ok: true,
      note: 'list logs'
    });
    let parsed: { records?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw) as { records?: Array<Record<string, unknown>> };
    } catch (err) {
      throw new SfCliError('Failed to parse Tooling API query response', undefined, err);
    }
    return (parsed.records ?? []).map(r => normalizeLogRecord(r));
  }

  async fetchLogBody(username: string, logId: string, timeoutMs?: number): Promise<string> {
    // Individual body GETs are deliberately not recorded in the command trail —
    // a 25-log fetch would flood its 50-entry capacity. The caller records one
    // summary entry per batch instead.
    const body = await this.request(
      username,
      conn => `${conn.instanceUrl}/services/data/v${conn.apiVersion}/tooling/sobjects/ApexLog/${encodeURIComponent(logId)}/Body`,
      { timeoutMs }
    );
    // Same contract as the CLI path: an ApexLog body is never legitimately empty.
    if (!body) {
      throw new SfCliError(`Empty log body returned for ${logId}`);
    }
    return body;
  }

  private getEntry(username: string, timeoutMs?: number): CacheEntry {
    let entry = this.connections.get(username);
    if (!entry) {
      // Cache the promise (not the value) so concurrent workers at batch start
      // share a single `sf org display` instead of spawning one each. A failed
      // promise stays cached to fail fast for the rest of the batch; the next
      // fetch clears it via resetIfFailed().
      const created: CacheEntry = { promise: undefined as unknown as Promise<OrgConnection>, failed: false };
      created.promise = this.session.orgDisplay(username, timeoutMs).then(conn => {
        const override = this.apiVersionOverride();
        return override ? { ...conn, apiVersion: override } : conn;
      }).catch(err => {
        created.failed = true;
        throw err;
      });
      this.connections.set(username, created);
      entry = created;
    }
    return entry;
  }

  /**
   * Issue a Tooling API request against the org, refreshing the cached session
   * once on 401 (shared by GET/POST/PATCH). `urlOf` builds the URL from the
   * resolved connection so the caller stays token-unaware. Options carry the
   * HTTP method (default GET), an optional JSON body, and a per-request timeout.
   */
  private async request(
    username: string,
    urlOf: (conn: OrgConnection) => string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {}
  ): Promise<string> {
    const { method = 'GET', body, timeoutMs } = opts;
    const entry = this.getEntry(username, timeoutMs);
    let conn = await entry.promise;
    let res = await this.send(urlOf(conn), conn.accessToken, method, body, timeoutMs);
    if (res.status === 401) {
      // Session expired — refresh the token once via the CLI and retry. Only
      // drop the cached session if it is still the one that got the 401; in a
      // concurrent 401 wave a sibling worker may have refreshed it already,
      // and re-invalidating would spawn one `sf org display` per worker.
      if (this.connections.get(username) === entry) {
        this.connections.delete(username);
      }
      conn = await this.getEntry(username, timeoutMs).promise;
      res = await this.send(urlOf(conn), conn.accessToken, method, body, timeoutMs);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch { /* body unavailable — status alone will do */ }
      throw new SfCliError(`Salesforce REST request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.text();
  }

  private async send(url: string, token: string, method: string, body: unknown, timeoutMs?: number): Promise<RestResponse> {
    if (!this.fetchFn) {
      throw new SfCliError('No fetch implementation available for REST calls');
    }
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    if (bodyStr !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        signal: controller.signal
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new SfCliError(`Salesforce REST request timed out after ${effectiveTimeout}ms`);
      }
      // Wrap transport errors without echoing the request init (token lives there).
      throw new SfCliError(`Salesforce REST request failed: ${(err as Error)?.message ?? String(err)}`, undefined, err);
    } finally {
      clearTimeout(timer);
    }
  }

  // ─────────────────────────── Tooling helpers ───────────────────────────
  // Small typed wrappers used by TraceFlag ensure (below). They reuse the same
  // session cache + single-refresh-on-401 as the log fetch paths.

  /** Run a Tooling SOQL query and return its records. */
  async toolingQuery<T>(username: string, soql: string, timeoutMs?: number): Promise<T[]> {
    const raw = await this.request(
      username,
      conn => `${conn.instanceUrl}/services/data/v${conn.apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
      { timeoutMs }
    );
    let parsed: { records?: T[] };
    try {
      parsed = JSON.parse(raw) as { records?: T[] };
    } catch (err) {
      throw new SfCliError('Failed to parse Tooling API query response', undefined, err);
    }
    return parsed.records ?? [];
  }

  /** Create a Tooling sObject; returns the new record id (Salesforce replies `{ id, success }`). */
  async toolingCreate(username: string, sobject: string, fields: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    const raw = await this.request(
      username,
      conn => `${conn.instanceUrl}/services/data/v${conn.apiVersion}/tooling/sobjects/${sobject}`,
      { method: 'POST', body: fields, timeoutMs }
    );
    let parsed: { id?: string; success?: boolean };
    try {
      parsed = JSON.parse(raw) as { id?: string; success?: boolean };
    } catch (err) {
      throw new SfCliError(`Failed to parse Tooling API create response for ${sobject}`, undefined, err);
    }
    if (!parsed.id) {
      throw new SfCliError(`Tooling API create for ${sobject} returned no id`);
    }
    return parsed.id;
  }
}
