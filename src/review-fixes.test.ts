import { describe, expect, it } from 'vitest';
import { parseLogs } from './logParser';
import { parseCodeUnit, extractSoqlFromRaw, parseLimits } from './summaryGenerator';
import { extractLogBody } from './sfCliService';

describe('logParser.parseLogs', () => {
  it('attaches untimestamped continuation lines to the previous entry', () => {
    const raw = [
      '16:00:00.0 (1)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101',
      'Class.Foo.bar: line 10, column 1',
      'Class.Foo.baz: line 20, column 1'
    ].join('\n');
    const entries = parseLogs(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('FATAL_ERROR');
    expect(entries[0].lineRef).toBe(''); // FATAL_ERROR has no [N] line ref
    expect(entries[0].message).toContain('System.LimitException');
    expect(entries[0].message).toContain('Class.Foo.baz');
  });

  it('detects a [N] line ref but not a non-bracketed first segment', () => {
    const withRef = parseLogs('16:00:00.0 (1)|USER_DEBUG|[42]|DEBUG|hello')[0];
    expect(withRef.lineRef).toBe('[42]');
    expect(withRef.message).toContain('hello');
  });
});

describe('summaryGenerator.parseCodeUnit — trigger detection', () => {
  it('parses a trigger CODE_UNIT even though the marker is the last segment', () => {
    const entry = parseLogs(
      '16:00:00.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01q5g00000ABCDE|MyTrigger on Account trigger event BeforeInsert|__sfdc_trigger/MyTrigger'
    )[0];
    const cu = parseCodeUnit(entry);
    expect(cu.isTrigger).toBe(true);
    expect(cu.className).toBe('MyTrigger');
    expect(cu.detail).toBe('BeforeInsert on Account');
  });

  it('recovers a trigger name from a __sfdc_trigger/ marker when no descriptor is present', () => {
    const entry = parseLogs('16:00:00.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|__sfdc_trigger/AcctTrg')[0];
    const cu = parseCodeUnit(entry);
    expect(cu.isTrigger).toBe(true);
    expect(cu.className).toBe('AcctTrg');
  });

  it('parses a non-trigger class.method unit', () => {
    const entry = parseLogs('16:00:00.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|MyClass.myMethod')[0];
    const cu = parseCodeUnit(entry);
    expect(cu.isTrigger).toBe(false);
    expect(cu.className).toBe('MyClass');
  });
});

describe('summaryGenerator.extractSoqlFromRaw — pipe-safe query', () => {
  it('preserves a pipe inside the SOQL query', () => {
    const entry = parseLogs(
      "16:00:01.0 (2)|SOQL_EXECUTE_BEGIN|[12]|Aggregations:0|SELECT Id FROM Account WHERE Name = 'a|b'"
    )[0];
    const { query, aggregations } = extractSoqlFromRaw(entry);
    expect(aggregations).toBe('Aggregations:0');
    expect(query).toBe("SELECT Id FROM Account WHERE Name = 'a|b'");
  });
});

describe('summaryGenerator.parseLimits — per-namespace metrics', () => {
  it('does not let a managed-package namespace overwrite the (default) metrics', () => {
    const raw = [
      '16:00:02.0 (1)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Number of SOQL queries: 5 out of 100',
      '16:00:02.1 (2)|LIMIT_USAGE_FOR_NS|myns|',
      '  Number of SOQL queries: 90 out of 100'
    ].join('\n');
    const metrics = parseLimits(raw);
    const def = metrics.find(m => m.name === 'SOQL queries');
    const ns = metrics.find(m => m.name === 'myns: SOQL queries');
    expect(def?.used).toBe(5);
    expect(ns?.used).toBe(90);
  });
});

describe('sfCliService.extractLogBody', () => {
  it('handles string, lowercase log, PascalCase Log, arrays, and empties', () => {
    expect(extractLogBody('raw log text')).toBe('raw log text');
    expect(extractLogBody({ log: 'lower' })).toBe('lower');
    expect(extractLogBody({ Log: 'pascal' })).toBe('pascal'); // Tooling-API shape
    expect(extractLogBody([{ Log: 'arr-pascal' }])).toBe('arr-pascal');
    expect(extractLogBody(['arr-string'])).toBe('arr-string');
    expect(extractLogBody([])).toBe('');
    expect(extractLogBody({})).toBe('');
    expect(extractLogBody(null)).toBe('');
  });
});
