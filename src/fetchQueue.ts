/**
 * Concurrency-limited work queue over an ordered item list, with the ability to
 * bump a not-yet-started item to the front — used when the user clicks a log row
 * whose body is still waiting to download.
 */
export class FetchQueue<T> {
  private readonly pending: T[];
  private readonly started = new Set<string>();
  private readonly settled = new Set<string>();

  constructor(items: readonly T[], private readonly keyOf: (item: T) => string) {
    this.pending = [...items];
  }

  /** Move a queued item to the front so a worker picks it up next. No-op once started. */
  prioritize(key: string): boolean {
    if (this.started.has(key)) return false;
    const idx = this.pending.findIndex(item => this.keyOf(item) === key);
    if (idx < 0) return false;
    if (idx > 0) {
      const [item] = this.pending.splice(idx, 1);
      this.pending.unshift(item);
    }
    return true;
  }

  /** True while the item has neither finished nor failed — still queued or in flight. */
  isOutstanding(key: string): boolean {
    return !this.settled.has(key) &&
      (this.started.has(key) || this.pending.some(item => this.keyOf(item) === key));
  }

  /**
   * Run `worker` over all items with at most `concurrency` in flight.
   * Worker rejections propagate — callers are expected to catch per-item errors.
   */
  async run(concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    const width = Math.max(1, Math.min(concurrency, this.pending.length));
    const runners = Array.from({ length: width }, async () => {
      while (this.pending.length > 0) {
        const item = this.pending.shift()!;
        const key = this.keyOf(item);
        this.started.add(key);
        try {
          await worker(item);
        } finally {
          this.settled.add(key);
        }
      }
    });
    await Promise.all(runners);
  }
}
