import { describe, expect, it } from 'vitest';
import { FetchQueue } from './fetchQueue';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('FetchQueue', () => {
  it('processes every item and respects the concurrency cap', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const queue = new FetchQueue(items, s => s);
    const done: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await queue.run(2, async item => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      done.push(item);
      inFlight -= 1;
    });
    expect(done.sort()).toEqual(items);
    expect(maxInFlight).toBe(2);
  });

  it('starts items in order (newest-first list stays newest-first)', async () => {
    const queue = new FetchQueue(['n1', 'n2', 'n3'], s => s);
    const startOrder: string[] = [];
    await queue.run(1, async item => {
      startOrder.push(item);
      await tick();
    });
    expect(startOrder).toEqual(['n1', 'n2', 'n3']);
  });

  it('prioritize moves a queued item to the front', async () => {
    const queue = new FetchQueue(['a', 'b', 'c', 'd'], s => s);
    const startOrder: string[] = [];
    const running = queue.run(1, async item => {
      startOrder.push(item);
      if (item === 'a') {
        expect(queue.prioritize('d')).toBe(true);
      }
      await tick();
    });
    await running;
    expect(startOrder).toEqual(['a', 'd', 'b', 'c']);
  });

  it('prioritize is a no-op for started or unknown items', async () => {
    const queue = new FetchQueue(['a', 'b'], s => s);
    await queue.run(2, async item => {
      if (item === 'a') expect(queue.prioritize('a')).toBe(false);
      await tick();
    });
    expect(queue.prioritize('nope')).toBe(false);
  });

  it('isOutstanding covers queued and in-flight items, not settled ones', async () => {
    const queue = new FetchQueue(['a', 'b'], s => s);
    expect(queue.isOutstanding('a')).toBe(true);
    await queue.run(1, async item => {
      // While 'a' runs it is outstanding; 'b' is still queued and outstanding.
      if (item === 'a') {
        expect(queue.isOutstanding('a')).toBe(true);
        expect(queue.isOutstanding('b')).toBe(true);
      }
      await tick();
    });
    expect(queue.isOutstanding('a')).toBe(false);
    expect(queue.isOutstanding('b')).toBe(false);
  });

  it('marks an item settled even when the worker throws', async () => {
    const queue = new FetchQueue(['boom'], s => s);
    await expect(queue.run(1, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(queue.isOutstanding('boom')).toBe(false);
  });
});
