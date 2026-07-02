import { describe, expect, it } from 'vitest';
import { apexLogQuery, quoteForCmd } from './sfCliService';

describe('sfCliService.quoteForCmd', () => {
  it('passes simple tokens through untouched', () => {
    expect(quoteForCmd('org')).toBe('org');
    expect(quoteForCmd('--target-org')).toBe('--target-org');
    expect(quoteForCmd('user@example.com')).toBe('user@example.com');
    expect(quoteForCmd('07L000000000001')).toBe('07L000000000001');
  });

  it('wraps arguments containing spaces (SOQL queries) in double quotes', () => {
    expect(quoteForCmd('SELECT Id FROM ApexLog')).toBe('"SELECT Id FROM ApexLog"');
  });

  it('doubles embedded double quotes per cmd.exe convention', () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes cmd metacharacters', () => {
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('a|b')).toBe('"a|b"');
  });
});

describe('sfCliService.apexLogQuery', () => {
  it('clamps the limit into [1, 200]', () => {
    expect(apexLogQuery(25)).toContain('LIMIT 25');
    expect(apexLogQuery(0)).toContain('LIMIT 1');
    expect(apexLogQuery(9999)).toContain('LIMIT 200');
    expect(apexLogQuery(10.7)).toContain('LIMIT 10');
  });

  it('orders newest first so the progressive list fills from the top', () => {
    expect(apexLogQuery(25)).toContain('ORDER BY StartTime DESC');
  });
});
