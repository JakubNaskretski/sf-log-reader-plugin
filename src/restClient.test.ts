import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandTrail } from './commandTrail';
import { FetchLike, RestResponse, SfRestService } from './restClient';
import { OrgConnection, SfCliError } from './sfCliService';

const TOKEN = 'SECRET-TOKEN-00D5g000004xyzA';

function conn(overrides: Partial<OrgConnection> = {}): OrgConnection {
  return {
    instanceUrl: 'https://example-dev-ed.my.salesforce.com',
    accessToken: TOKEN,
    apiVersion: '61.0',
    ...overrides
  };
}

function ok(body: string): RestResponse {
  return { ok: true, status: 200, text: async () => body };
}

function fail(status: number, body = ''): RestResponse {
  return { ok: false, status, text: async () => body };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: string;
}

function makeService(responses: Array<RestResponse | Error>, sessions: Array<OrgConnection | Error>) {
  const calls: Call[] = [];
  let sessionCalls = 0;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method, body: init.body });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) throw next;
    return next;
  };
  const session = {
    orgDisplay: async () => {
      sessionCalls += 1;
      const next = sessions.shift();
      if (!next) throw new Error('unexpected extra orgDisplay call');
      if (next instanceof Error) throw next;
      return next;
    }
  };
  const trail = new CommandTrail();
  const service = new SfRestService(session, trail, fetchFn);
  return { service, calls, trail, sessionCount: () => sessionCalls };
}

describe('SfRestService.fetchLogBody', () => {
  it('GETs the Tooling API Body endpoint with a bearer token', async () => {
    const { service, calls } = makeService([ok('LOG BODY')], [conn()]);
    const body = await service.fetchLogBody('user@example.com', '07L000000000001');
    expect(body).toBe('LOG BODY');
    expect(calls[0].url).toBe(
      'https://example-dev-ed.my.salesforce.com/services/data/v61.0/tooling/sobjects/ApexLog/07L000000000001/Body'
    );
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reuses one session across calls, including concurrent ones', async () => {
    const { service, sessionCount } = makeService([ok('a'), ok('b'), ok('c')], [conn()]);
    await Promise.all([
      service.fetchLogBody('u', '07L1'),
      service.fetchLogBody('u', '07L2')
    ]);
    await service.fetchLogBody('u', '07L3');
    expect(sessionCount()).toBe(1);
  });

  it('refreshes the session once on 401 and retries', async () => {
    const { service, calls, sessionCount } = makeService(
      [fail(401), ok('AFTER REFRESH')],
      [conn({ accessToken: 'expired' }), conn({ accessToken: 'fresh' })]
    );
    const body = await service.fetchLogBody('u', '07L1');
    expect(body).toBe('AFTER REFRESH');
    expect(sessionCount()).toBe(2);
    expect(calls[1].headers.Authorization).toBe('Bearer fresh');
  });

  it('refreshes the session only once when concurrent calls 401 together', async () => {
    // Both workers hit 401 with the stale token, but only the first should
    // invalidate — the second must reuse the sibling's refreshed session.
    const { service, sessionCount } = makeService(
      [fail(401), fail(401), ok('a'), ok('b')],
      [conn({ accessToken: 'expired' }), conn({ accessToken: 'fresh' })]
    );
    const [a, b] = await Promise.all([
      service.fetchLogBody('u', '07L1'),
      service.fetchLogBody('u', '07L2')
    ]);
    expect([a, b].sort()).toEqual(['a', 'b']);
    expect(sessionCount()).toBe(2);
  });

  it('throws on repeated 401 without looping', async () => {
    const { service } = makeService([fail(401), fail(401)], [conn(), conn()]);
    await expect(service.fetchLogBody('u', '07L1')).rejects.toThrow(/HTTP 401/);
  });

  it('never includes the access token in error messages', async () => {
    const { service } = makeService([fail(500, 'server exploded')], [conn()]);
    const err = await service.fetchLogBody('u', '07L1').catch(e => e as SfCliError);
    expect(err).toBeInstanceOf(SfCliError);
    expect((err as Error).message).toContain('HTTP 500');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('rejects an empty body like the CLI path does', async () => {
    const { service } = makeService([ok('')], [conn()]);
    await expect(service.fetchLogBody('u', '07L1')).rejects.toThrow(/Empty log body/);
  });

  it('fails fast for the rest of a batch after a session failure, and retries after resetIfFailed', async () => {
    const { service, sessionCount } = makeService(
      [ok('works now')],
      [new Error('no refresh token'), conn()]
    );
    await expect(service.fetchLogBody('u', '07L1')).rejects.toThrow('no refresh token');
    // Second call reuses the cached failure — no extra orgDisplay spawn.
    await expect(service.fetchLogBody('u', '07L2')).rejects.toThrow('no refresh token');
    expect(sessionCount()).toBe(1);
    service.resetIfFailed('u');
    await expect(service.fetchLogBody('u', '07L3')).resolves.toBe('works now');
    expect(sessionCount()).toBe(2);
  });

  it('honors an explicit apiVersion override over the org default', async () => {
    const calls: Call[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return ok('BODY');
    };
    const service = new SfRestService(
      { orgDisplay: async () => conn({ apiVersion: '61.0' }) },
      new CommandTrail(),
      fetchFn,
      () => '58.0'
    );
    await service.fetchLogBody('u', '07L1');
    expect(calls[0].url).toContain('/services/data/v58.0/');
  });

  it('maps an abort to a timeout error', async () => {
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    const service = new SfRestService({ orgDisplay: async () => conn() }, new CommandTrail(), fetchFn);
    await expect(service.fetchLogBody('u', '07L1', 20)).rejects.toThrow(/timed out after 20ms/);
  });
});

describe('SfRestService.queryLogs', () => {
  it('encodes the SOQL, parses records, and records one trail entry', async () => {
    const payload = JSON.stringify({
      records: [
        {
          attributes: { type: 'ApexLog' },
          Id: '07L000000000001',
          LogLength: 1234,
          LogUserId: '005000000000001',
          LogUser: { attributes: {}, Name: 'Ada Lovelace' },
          Operation: 'ApexTest',
          StartTime: '2026-07-01T10:00:00.000+0000',
          Status: 'Success'
        }
      ]
    });
    const { service, calls, trail } = makeService([ok(payload)], [conn()]);
    const records = await service.queryLogs('u', 25);
    expect(calls[0].url).toContain('/services/data/v61.0/tooling/query?q=SELECT');
    expect(calls[0].url).toContain(encodeURIComponent('ORDER BY StartTime DESC LIMIT 25'));
    expect(records).toHaveLength(1);
    expect(records[0].Id).toBe('07L000000000001');
    expect(records[0].LogUserName).toBe('Ada Lovelace');
    expect(records[0].LogLength).toBe(1234);
    const entries = trail.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].cmd).toBe('REST');
    expect(entries[0].args.join(' ')).not.toContain(TOKEN);
  });

  it('wraps malformed JSON in an SfCliError', async () => {
    const { service } = makeService([ok('<html>login page</html>')], [conn()]);
    await expect(service.queryLogs('u', 10)).rejects.toThrow(/parse/i);
  });
});

describe('SfRestService.toolingQuery / toolingCreate', () => {
  it('toolingQuery GETs the query endpoint and returns records', async () => {
    const { service, calls } = makeService(
      [ok(JSON.stringify({ records: [{ Id: '005000000000001' }] }))],
      [conn()]
    );
    const rows = await service.toolingQuery<{ Id: string }>('u', 'SELECT Id FROM User');
    expect(rows).toEqual([{ Id: '005000000000001' }]);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/tooling/query?q=SELECT');
  });

  it('toolingCreate POSTs a JSON body and returns the new id', async () => {
    const { service, calls } = makeService([ok(JSON.stringify({ id: '7tf000000000001', success: true }))], [conn()]);
    const id = await service.toolingCreate('u', 'TraceFlag', { LogType: 'DEVELOPER_LOG' });
    expect(id).toBe('7tf000000000001');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/tooling/sobjects/TraceFlag');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].body!)).toEqual({ LogType: 'DEVELOPER_LOG' });
    // The bearer token must be present on the POST too (session reuse).
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('toolingCreate refreshes the session once on 401 and retries the POST', async () => {
    const { service, calls, sessionCount } = makeService(
      [fail(401), ok(JSON.stringify({ id: 'newid' }))],
      [conn({ accessToken: 'expired' }), conn({ accessToken: 'fresh' })]
    );
    const id = await service.toolingCreate('u', 'DebugLevel', { DeveloperName: 'X' });
    expect(id).toBe('newid');
    expect(sessionCount()).toBe(2);
    expect(calls[1].headers.Authorization).toBe('Bearer fresh');
  });

  it('toolingCreate throws when the response carries no id', async () => {
    const { service } = makeService([ok(JSON.stringify({ success: false, errors: ['nope'] }))], [conn()]);
    await expect(service.toolingCreate('u', 'TraceFlag', {})).rejects.toThrow(/no id/);
  });
});

describe('SfRestService.available', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is false on runtimes without a global fetch', () => {
    // Passing undefined explicitly would just re-trigger the default parameter,
    // so simulate an old runtime by blanking the global itself.
    vi.stubGlobal('fetch', undefined);
    const service = new SfRestService({ orgDisplay: async () => conn() }, new CommandTrail());
    expect(service.available()).toBe(false);
  });

  it('is true with an injected fetch', () => {
    const { service } = makeService([], []);
    expect(service.available()).toBe(true);
  });
});
