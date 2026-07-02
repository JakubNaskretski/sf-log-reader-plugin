import { describe, expect, it } from 'vitest';
import { TraceService } from './traceService';
import { SfRestService } from './restClient';

/**
 * Fake SfRestService that records the tooling calls and returns scripted
 * results, so the ensure sequencing/branching is testable without a network.
 * TraceService only touches `toolingQuery` and `toolingCreate`.
 */
class FakeRest {
  queries: string[] = [];
  creates: Array<{ sobject: string; fields: Record<string, unknown> }> = [];
  constructor(
    private readonly queryResults: Array<unknown[]>,
    private readonly createIds: string[] = []
  ) {}
  async toolingQuery<T>(_u: string, soql: string): Promise<T[]> {
    this.queries.push(soql);
    return (this.queryResults.shift() ?? []) as T[];
  }
  async toolingCreate(_u: string, sobject: string, fields: Record<string, unknown>): Promise<string> {
    this.creates.push({ sobject, fields });
    return this.createIds.shift() ?? 'created-id';
  }
}

function svc(rest: FakeRest): TraceService {
  return new TraceService(rest as unknown as SfRestService);
}

describe('TraceService.ensureTraceFlag', () => {
  it('short-circuits when a live TraceFlag already exists (no create)', async () => {
    // User lookup → existing TraceFlag present.
    const rest = new FakeRest([[{ Id: '005user' }], [{ Id: '7tfexisting' }]]);
    const t = svc(rest);
    const msg = await t.ensureTraceFlag('user@org', 'user@org');
    expect(msg).toMatch(/already enabled/i);
    expect(rest.creates).toHaveLength(0);
  });

  it('creates a DebugLevel and TraceFlag when none exists', async () => {
    // User lookup → no existing TraceFlag → no existing DebugLevel.
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], []],
      ['dbglvlId', 'traceflagId']
    );
    const t = svc(rest);
    const msg = await t.ensureTraceFlag('user@org', 'user@org');
    expect(msg).toMatch(/enabled/i);
    expect(rest.creates.map(c => c.sobject)).toEqual(['DebugLevel', 'TraceFlag']);
    const tf = rest.creates.find(c => c.sobject === 'TraceFlag')!;
    expect(tf.fields.TracedEntityId).toBe('005user');
    expect(tf.fields.DebugLevelId).toBe('dbglvlId');
    expect(tf.fields.LogType).toBe('DEVELOPER_LOG');
  });

  it('reuses an existing DebugLevel rather than creating a second one', async () => {
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], [{ Id: 'existingDbgLvl' }]],
      ['traceflagId']
    );
    const t = svc(rest);
    await t.ensureTraceFlag('user@org', 'user@org');
    expect(rest.creates.map(c => c.sobject)).toEqual(['TraceFlag']);
    const tf = rest.creates[0];
    expect(tf.fields.DebugLevelId).toBe('existingDbgLvl');
  });

  it('throws when the user Id cannot be resolved', async () => {
    const rest = new FakeRest([[]]); // user lookup returns nothing
    const t = svc(rest);
    await expect(t.ensureTraceFlag('user@org', 'user@org')).rejects.toThrow(/user Id/i);
  });

  it('caches after a successful ensure so a second call makes no tooling calls', async () => {
    const rest = new FakeRest([[{ Id: '005user' }], [], []], ['dbg', 'tf']);
    const t = svc(rest);
    await t.ensureTraceFlag('user@org', 'user@org');
    const queriesAfterFirst = rest.queries.length;
    const createsAfterFirst = rest.creates.length;
    const msg2 = await t.ensureTraceFlag('user@org', 'user@org');
    expect(msg2).toMatch(/already enabled/i);
    expect(rest.queries.length).toBe(queriesAfterFirst); // no new queries
    expect(rest.creates.length).toBe(createsAfterFirst); // no new creates
  });

  it('escapes quotes in the username SOQL literal', async () => {
    const rest = new FakeRest([[{ Id: '005user' }], [{ Id: 'tf' }]]);
    const t = svc(rest);
    await t.ensureTraceFlag('org', "o'brien@org");
    // The User query is the first query; the quote must be backslash-escaped.
    expect(rest.queries[0]).toContain("Username = 'o\\'brien@org'");
  });
});
