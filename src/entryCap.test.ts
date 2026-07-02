import { describe, expect, it } from 'vitest';
import { capEntries, HOST_ENTRY_CAP } from './entryCap';

describe('entryCap.capEntries', () => {
  it('returns the array unchanged and truncated=false when under the cap', () => {
    const input = [1, 2, 3];
    const { entries, truncated } = capEntries(input, 10);
    expect(entries).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('returns a copy (never the input array) so the source cannot be mutated', () => {
    const input = [1, 2, 3];
    const { entries } = capEntries(input, 10);
    expect(entries).not.toBe(input);
  });

  it('caps to exactly `cap` and reports truncated=true when over', () => {
    const input = Array.from({ length: 100 }, (_, i) => i);
    const { entries, truncated } = capEntries(input, 25);
    expect(entries).toHaveLength(25);
    expect(entries[0]).toBe(0);
    expect(entries[24]).toBe(24);
    expect(truncated).toBe(true);
  });

  it('treats an array exactly at the cap as not truncated', () => {
    const input = Array.from({ length: 5 }, (_, i) => i);
    expect(capEntries(input, 5).truncated).toBe(false);
    expect(capEntries(input, 5).entries).toHaveLength(5);
  });

  it('defaults to HOST_ENTRY_CAP', () => {
    const over = Array.from({ length: HOST_ENTRY_CAP + 1 }, (_, i) => i);
    const { entries, truncated } = capEntries(over);
    expect(entries).toHaveLength(HOST_ENTRY_CAP);
    expect(truncated).toBe(true);
    const under = Array.from({ length: HOST_ENTRY_CAP }, (_, i) => i);
    expect(capEntries(under).truncated).toBe(false);
  });
});
