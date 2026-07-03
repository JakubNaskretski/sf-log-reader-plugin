import { describe, expect, it } from 'vitest';
import { parseLogs } from './logParser';
import { buildCallTree, SPAN_CAP, Span } from './callTree';

/** Parse a fixture (array of lines) then build the call tree. */
function tree(lines: string[]) {
  return buildCallTree(parseLogs(lines.join('\n')));
}

function byLabel(spans: Span[], label: string): Span | undefined {
  return spans.find(s => s.label === label);
}

describe('callTree.buildCallTree — nesting', () => {
  it('opens/closes nested CODE_UNIT + METHOD + leaf spans with correct depth', () => {
    const { spans, totalNanos } = tree([
      '16:00:00.0 (1000)|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0 (2000)|METHOD_ENTRY|[10]|01p|AcmeController.doWork()',
      '16:00:00.0 (3000)|SOQL_EXECUTE_BEGIN|[12]|Aggregations:0|SELECT Id FROM Account',
      '16:00:00.0 (4000)|SOQL_EXECUTE_END|[12]|Rows:1',
      '16:00:00.0 (5000)|DML_BEGIN|[15]|Op:Insert|Type:Account|Rows:2',
      '16:00:00.0 (6000)|DML_END|[15]',
      '16:00:00.0 (7000)|METHOD_EXIT|[10]|01p|AcmeController.doWork()',
      '16:00:00.0 (8000)|CODE_UNIT_FINISHED|[EXTERNAL]|AcmeController.doWork'
    ]);

    expect(spans).toHaveLength(4);
    const codeUnit = spans.find(s => s.kind === 'CODE_UNIT')!;
    const method = spans.find(s => s.kind === 'METHOD')!;
    const soql = spans.find(s => s.kind === 'SOQL')!;
    const dml = spans.find(s => s.kind === 'DML')!;

    expect(codeUnit.depth).toBe(0);
    expect(codeUnit.parent).toBeNull();
    expect(method.depth).toBe(1);
    expect(method.parent).toBe(codeUnit.id);
    // Leaf spans nest under the method.
    expect(soql.depth).toBe(2);
    expect(soql.parent).toBe(method.id);
    expect(dml.depth).toBe(2);
    expect(dml.parent).toBe(method.id);

    expect(codeUnit.startNanos).toBe(1000);
    expect(codeUnit.endNanos).toBe(8000);
    expect(soql.startNanos).toBe(3000);
    expect(soql.endNanos).toBe(4000);
    expect(totalNanos).toBe(8000);
    expect(spans.every(s => s.truncated === undefined)).toBe(true);
  });

  it('builds leaf-span labels: SOQL query, "Insert Account", callout, method sig', () => {
    const { spans } = tree([
      '16:00:00.0 (1000)|CODE_UNIT_STARTED|[EXTERNAL]|__sfdc_trigger/Acme_Trigger',
      '16:00:00.0 (2000)|METHOD_ENTRY|[10]|01p|AcmeService.run()',
      '16:00:00.0 (3000)|SOQL_EXECUTE_BEGIN|[12]|Aggregations:0|SELECT Id FROM Contact',
      '16:00:00.0 (4000)|SOQL_EXECUTE_END|[12]|Rows:1',
      '16:00:00.0 (5000)|DML_BEGIN|[15]|Op:Insert|Type:Account|Rows:1',
      '16:00:00.0 (6000)|DML_END|[15]',
      '16:00:00.0 (7000)|CALLOUT_REQUEST|[20]|System.HttpRequest[Endpoint=https://api.example.com/v1]',
      '16:00:00.0 (8000)|CALLOUT_RESPONSE|[20]|System.HttpResponse[Status=OK, StatusCode=200]',
      '16:00:00.0 (9000)|METHOD_EXIT|[10]|01p|AcmeService.run()',
      '16:00:00.0 (10000)|CODE_UNIT_FINISHED|[EXTERNAL]|__sfdc_trigger/Acme_Trigger'
    ]);
    expect(byLabel(spans, 'SELECT Id FROM Contact')).toBeTruthy();
    expect(byLabel(spans, 'Insert Account')).toBeTruthy();
    expect(byLabel(spans, 'AcmeService.run()')).toBeTruthy();
    // trigger CODE_UNIT label uses the trigger name
    expect(byLabel(spans, 'Acme_Trigger')).toBeTruthy();
    // callout label uses the descriptor segment
    expect(spans.find(s => s.kind === 'CALLOUT')?.label).toContain('api.example.com');
  });
});

describe('callTree.buildCallTree — null-nanos fallback', () => {
  it('carries forward the last known nanos when timestampNanos is null', () => {
    // Continuation-style lines without the (N) nanos marker parse to timestampNanos=null.
    const { spans } = tree([
      '16:00:00.0 (1000)|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0|METHOD_ENTRY|[10]|01p|AcmeController.helper()',
      '16:00:00.0|METHOD_EXIT|[10]|01p|AcmeController.helper()',
      '16:00:00.0 (5000)|CODE_UNIT_FINISHED|[EXTERNAL]|AcmeController.doWork'
    ]);
    const method = spans.find(s => s.kind === 'METHOD')!;
    // Both entry and exit had null nanos -> carried forward from the 1000 opener.
    expect(method.startNanos).toBe(1000);
    expect(method.endNanos).toBe(1000);
    const codeUnit = spans.find(s => s.kind === 'CODE_UNIT')!;
    expect(codeUnit.endNanos).toBe(5000);
  });

  it('uses 0 when the log starts with null nanos', () => {
    const { spans } = tree([
      '16:00:00.0|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0|CODE_UNIT_FINISHED|[EXTERNAL]|AcmeController.doWork'
    ]);
    expect(spans[0].startNanos).toBe(0);
    expect(spans[0].endNanos).toBe(0);
  });
});

describe('callTree.buildCallTree — unbalanced / truncated logs', () => {
  it('closes all open frames at EOF as truncated at the last seen nanos', () => {
    const { spans, totalNanos } = tree([
      '16:00:00.0 (1000)|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0 (2000)|METHOD_ENTRY|[10]|01p|AcmeController.doWork()',
      '16:00:00.0 (3000)|SOQL_EXECUTE_BEGIN|[12]|Aggregations:0|SELECT Id FROM Account',
      '16:00:00.0 (4000)|USER_DEBUG|[13]|DEBUG|MAXIMUM DEBUG LOG SIZE REACHED'
    ]);
    // 3 open frames, none closed -> all truncated, all end at last nanos (4000).
    expect(spans).toHaveLength(3);
    expect(spans.every(s => s.truncated === true)).toBe(true);
    expect(spans.every(s => s.endNanos === 4000)).toBe(true);
    expect(totalNanos).toBe(4000);
  });

  it('tolerates a stray EXIT with no matching open frame (ignores it)', () => {
    const { spans } = tree([
      '16:00:00.0 (1000)|METHOD_EXIT|[10]|01p|Ghost.method()',
      '16:00:00.0 (2000)|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0 (3000)|CODE_UNIT_FINISHED|[EXTERNAL]|AcmeController.doWork'
    ]);
    // The stray METHOD_EXIT produced no span; only the balanced CODE_UNIT remains.
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('CODE_UNIT');
    expect(spans[0].truncated).toBeUndefined();
  });

  it('closes intervening open frames as truncated when an ancestor closes first (pop-mismatch)', () => {
    const { spans } = tree([
      '16:00:00.0 (1000)|CODE_UNIT_STARTED|[EXTERNAL]|AcmeController.doWork',
      '16:00:00.0 (2000)|METHOD_ENTRY|[10]|01p|AcmeController.inner()',
      // The method never gets its own EXIT; the CODE_UNIT closes, forcing it shut.
      '16:00:00.0 (5000)|CODE_UNIT_FINISHED|[EXTERNAL]|AcmeController.doWork'
    ]);
    const method = spans.find(s => s.kind === 'METHOD')!;
    const codeUnit = spans.find(s => s.kind === 'CODE_UNIT')!;
    expect(method.truncated).toBe(true);
    expect(method.endNanos).toBe(5000);
    expect(codeUnit.truncated).toBeUndefined();
    expect(codeUnit.endNanos).toBe(5000);
  });
});

describe('callTree.buildCallTree — span cap', () => {
  it('stops emitting new spans past SPAN_CAP and sets spanCapHit', () => {
    const lines: string[] = [];
    // Emit many leaf SOQL spans (each is BEGIN+END) so we overshoot the cap.
    const pairs = SPAN_CAP + 100;
    let t = 0;
    for (let i = 0; i < pairs; i++) {
      lines.push(`16:00:00.0 (${++t})|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account`);
      lines.push(`16:00:00.0 (${++t})|SOQL_EXECUTE_END|[1]|Rows:0`);
    }
    const { spans, spanCapHit } = buildCallTree(parseLogs(lines.join('\n')));
    expect(spanCapHit).toBe(true);
    expect(spans.length).toBe(SPAN_CAP);
    // Spans that were emitted still closed cleanly (not truncated).
    expect(spans.every(s => s.truncated === undefined)).toBe(true);
  });
});

describe('callTree.buildCallTree — label truncation', () => {
  it('truncates long labels to ~120 chars but keeps full text in detail', () => {
    const longQuery = 'SELECT ' + Array.from({ length: 60 }, (_, i) => `Field${i}__c`).join(', ') + ' FROM Account';
    const { spans } = tree([
      `16:00:00.0 (1000)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|${longQuery}`,
      '16:00:00.0 (2000)|SOQL_EXECUTE_END|[1]|Rows:0'
    ]);
    const soql = spans[0];
    expect(soql.label.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(soql.label.endsWith('…')).toBe(true);
    expect(soql.detail).toBe(longQuery);
    expect(soql.detail.length).toBeGreaterThan(121);
  });
});
