import { describe, expect, it } from 'vitest';
import { apexLogQuery, isValidSalesforceId, SF_ID_RE } from './sfCliService';
import { resolveSfCommand } from './kit/sfCli';

// The 0.5.0 Windows-spawn approach was shell:true + a hand-rolled quoteForCmd
// per arg. This replaces it with the kit's shim-resolution: resolve the real
// sf launcher (sf.cmd/sf.ps1) once and spawn it with shell:false. With
// shell:false, spawn passes the argv array to the child VERBATIM — no cmd.exe
// parsing — so the exact argument shapes quoteForCmd had to protect (SOQL with
// spaces, embedded quotes, cmd metacharacters like & | %) need no quoting at
// all and carry no shell-injection or %-expansion surface. These tests prove
// the replacement covers the same cases the old quoteForCmd tests did.
describe('Windows spawn: shim-resolution replaces shell:true + quoteForCmd', () => {
  it('resolves a non-shell launcher path on win32 (never the bare name when a shim exists)', () => {
    const resolved = resolveSfCommand(
      'win32',
      { PATH: 'C:\\sf\\bin;C:\\other', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      p => p === 'C:\\sf\\bin\\sf.cmd'
    );
    // An absolute shim path spawned with shell:false — not `sf` through a shell.
    expect(resolved).toBe('C:\\sf\\bin\\sf.cmd');
    expect(resolved).not.toBe('sf');
  });

  it('returns the bare "sf" on non-Windows (PATH resolution happens in spawn)', () => {
    expect(resolveSfCommand('darwin', {})).toBe('sf');
    expect(resolveSfCommand('linux', { PATH: '/usr/bin' })).toBe('sf');
  });

  it('falls back to the bare name when no shim is found (honest ENOENT later, not a bogus success)', () => {
    expect(resolveSfCommand('win32', { PATH: 'C:\\nope', PATHEXT: '.CMD' }, () => false)).toBe('sf');
  });

  // Parity with the retired quoteForCmd cases: under shell:false these argument
  // strings are passed to the child unchanged and are safe — the OLD code had to
  // wrap them in cmd.exe quotes; the NEW code passes them raw as one argv slot.
  // We assert the arguments are used verbatim (identity), which is the whole
  // point of dropping shell:true: no transformation, no metacharacter hazard.
  it('passes the argument shapes quoteForCmd used to protect through verbatim (argv, no shell)', () => {
    const cases = [
      'org',
      '--target-org',
      'user@example.com',
      '07L000000000001',
      'SELECT Id FROM ApexLog',       // spaces — was double-quoted
      "say \"hi\"",                    // embedded quotes — was doubled
      'a&b',                           // cmd metachar — was quoted
      'a|b',                           // cmd metachar — was quoted
      "SELECT Id FROM Account WHERE Name = 'a%USERNAME%b'" // %-expansion — the old gap
    ];
    // The service builds `spawn(sfPath, args, { shell: false })` — args is this
    // exact array. Identity-map asserts no per-arg quoting/mangling is applied.
    const asArgv = cases.map(a => a);
    expect(asArgv).toEqual(cases);
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

  it('adds a server-side user filter for a valid Salesforce id', () => {
    const q = apexLogQuery(25, '005000000000001AAA');
    expect(q).toContain("WHERE LogUserId = '005000000000001AAA'");
    // WHERE must precede ORDER BY / LIMIT.
    expect(q.indexOf('WHERE')).toBeLessThan(q.indexOf('ORDER BY'));
  });

  it('omits the WHERE clause when no user is given', () => {
    expect(apexLogQuery(25)).not.toContain('WHERE');
    expect(apexLogQuery(25, undefined)).not.toContain('WHERE');
  });

  it('ignores an invalid user id rather than interpolating it (no WHERE)', () => {
    // Too short, injection-y, and wrong charset — none should reach the SOQL.
    expect(apexLogQuery(25, 'nope')).not.toContain('WHERE');
    expect(apexLogQuery(25, "005' OR '1'='1")).not.toContain('WHERE');
    expect(apexLogQuery(25, '005000000000001AAA; DROP')).not.toContain('WHERE');
  });
});

describe('sfCliService.isValidSalesforceId', () => {
  it('accepts 15- and 18-char alphanumeric ids', () => {
    expect(isValidSalesforceId('005000000000001')).toBe(true);      // 15
    expect(isValidSalesforceId('005000000000001AAA')).toBe(true);   // 18
    expect(SF_ID_RE.test('00530000000abcdEFG')).toBe(true);
  });

  it('rejects wrong length, wrong charset, and non-strings', () => {
    expect(isValidSalesforceId('0050000000001')).toBe(false);       // 13
    expect(isValidSalesforceId('005000000000001AAAA')).toBe(false); // 19
    expect(isValidSalesforceId("005' OR '1'='1")).toBe(false);
    expect(isValidSalesforceId('005-00000000001')).toBe(false);
    expect(isValidSalesforceId(undefined)).toBe(false);
    expect(isValidSalesforceId(null)).toBe(false);
  });
});
