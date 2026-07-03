import { describe, expect, it, vi } from 'vitest';
import { TraceService } from './traceService';
import { SfRestService } from './restClient';

// traceService.ts imports 'vscode' (for pickPresetAndEnsure's QuickPick). There's
// no real 'vscode' package under test — VS Code injects it as a virtual module at
// runtime — so we stub just the bit we exercise: showQuickPick. vi.mock calls are
// hoisted above imports by vitest, so this still applies before traceService loads.
const showQuickPick = vi.fn();
vi.mock('vscode', () => ({
  window: { showQuickPick: (...args: unknown[]) => showQuickPick(...args) }
}));

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

  it('defaults to the standard preset with today\'s exact DebugLevel field values', async () => {
    // No preset arg passed — must behave identically to before the preset param existed.
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], []],
      ['dbglvlId', 'traceflagId']
    );
    const t = svc(rest);
    await t.ensureTraceFlag('user@org', 'user@org');
    const dbgQuery = rest.queries.find(q => q.includes('DebugLevel'))!;
    expect(dbgQuery).toContain("DeveloperName = 'SfLogReaderDefault'");
    const dbg = rest.creates.find(c => c.sobject === 'DebugLevel')!;
    expect(dbg.fields).toEqual({
      MasterLabel: 'SfLogReaderDefault',
      DeveloperName: 'SfLogReaderDefault',
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
    });
  });

  it('explicit standard preset is identical to the default (unchanged for existing callers)', async () => {
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], []],
      ['dbglvlId', 'traceflagId']
    );
    const t = svc(rest);
    await t.ensureTraceFlag('user@org', 'user@org', undefined, 'standard');
    const dbg = rest.creates.find(c => c.sobject === 'DebugLevel')!;
    expect(dbg.fields.DeveloperName).toBe('SfLogReaderDefault');
    expect(dbg.fields.ApexCode).toBe('DEBUG');
    expect(dbg.fields.ApexProfiling).toBe('INFO');
  });

  it('profiling preset creates a separate FINEST DebugLevel with a distinct DeveloperName', async () => {
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], []],
      ['dbglvlProfilingId', 'traceflagId']
    );
    const t = svc(rest);
    const msg = await t.ensureTraceFlag('user@org', 'user@org', undefined, 'profiling');
    expect(msg).toMatch(/enabled/i);

    const dbgQuery = rest.queries.find(q => q.includes('DebugLevel'))!;
    expect(dbgQuery).toContain("DeveloperName = 'SfLogReaderDefault_Profiling'");

    const dbg = rest.creates.find(c => c.sobject === 'DebugLevel')!;
    expect(dbg.fields.DeveloperName).toBe('SfLogReaderDefault_Profiling');
    expect(dbg.fields.DeveloperName).not.toBe('SfLogReaderDefault');
    expect(dbg.fields).toEqual({
      MasterLabel: 'SfLogReaderDefault_Profiling',
      DeveloperName: 'SfLogReaderDefault_Profiling',
      ApexCode: 'FINEST',
      ApexProfiling: 'FINEST',
      Callout: 'INFO',
      Database: 'INFO',
      System: 'DEBUG',
      Validation: 'INFO',
      Visualforce: 'INFO',
      Workflow: 'INFO',
      NBA: 'INFO',
      Wave: 'INFO'
    });

    const tf = rest.creates.find(c => c.sobject === 'TraceFlag')!;
    expect(tf.fields.DebugLevelId).toBe('dbglvlProfilingId');
  });

  it('reuses an existing profiling DebugLevel rather than creating a second one', async () => {
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], [{ Id: 'existingProfilingDbgLvl' }]],
      ['traceflagId']
    );
    const t = svc(rest);
    await t.ensureTraceFlag('user@org', 'user@org', undefined, 'profiling');
    expect(rest.creates.map(c => c.sobject)).toEqual(['TraceFlag']);
    const tf = rest.creates[0];
    expect(tf.fields.DebugLevelId).toBe('existingProfilingDbgLvl');
  });
});

describe('TraceService.pickPresetAndEnsure', () => {
  it('cancel path (QuickPick dismissed) makes no REST calls and returns undefined', async () => {
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValue(undefined);
    const rest = new FakeRest([[{ Id: '005user' }], [], []], ['dbg', 'tf']);
    const t = svc(rest);
    const result = await t.pickPresetAndEnsure('user@org', 'user@org', 60_000);
    expect(result).toBeUndefined();
    expect(rest.queries).toHaveLength(0);
    expect(rest.creates).toHaveLength(0);
  });

  it('offers Standard and Profiling (FINEST) items', async () => {
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValue(undefined);
    const rest = new FakeRest([]);
    const t = svc(rest);
    await t.pickPresetAndEnsure('user@org', 'user@org', 60_000);
    const items = showQuickPick.mock.calls[0][0] as Array<{ label: string; preset: string }>;
    expect(items.map(i => i.label)).toEqual(['Standard', 'Profiling (FINEST)']);
    expect(items.find(i => i.label === 'Standard')!.preset).toBe('standard');
    expect(items.find(i => i.label === 'Profiling (FINEST)')!.preset).toBe('profiling');
  });

  it('picking Profiling (FINEST) calls ensureTraceFlag with the profiling preset', async () => {
    showQuickPick.mockReset();
    showQuickPick.mockImplementation(async (items: Array<{ label: string; preset: string }>) =>
      items.find(i => i.label === 'Profiling (FINEST)')
    );
    const rest = new FakeRest(
      [[{ Id: '005user' }], [], []],
      ['dbglvlProfilingId', 'traceflagId']
    );
    const t = svc(rest);
    const result = await t.pickPresetAndEnsure('user@org', 'user@org', 60_000);
    expect(result).toMatch(/enabled/i);
    const dbg = rest.creates.find(c => c.sobject === 'DebugLevel')!;
    expect(dbg.fields.DeveloperName).toBe('SfLogReaderDefault_Profiling');
  });
});
