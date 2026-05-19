export interface CommandTrailEntry {
  id: number;
  startedAt: number;
  durationMs: number;
  cmd: string;
  args: string[];
  exitCode: number;
  ok: boolean;
  stderrSnippet?: string;
  note?: string;
}

export type CommandTrailListener = (entry: CommandTrailEntry, all: CommandTrailEntry[]) => void;

const DEFAULT_CAPACITY = 50;

export class CommandTrail {
  private entries: CommandTrailEntry[] = [];
  private nextId = 1;
  private listeners: CommandTrailListener[] = [];

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  record(input: Omit<CommandTrailEntry, 'id'>): CommandTrailEntry {
    const entry: CommandTrailEntry = { id: this.nextId++, ...input };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try { listener(entry, this.entries); } catch { /* ignore */ }
    }
    return entry;
  }

  all(): CommandTrailEntry[] {
    return this.entries.slice();
  }

  clear(): void {
    this.entries = [];
    for (const listener of this.listeners) {
      try { listener({ id: 0, startedAt: Date.now(), durationMs: 0, cmd: '', args: [], exitCode: 0, ok: true, note: 'cleared' }, this.entries); } catch { /* ignore */ }
    }
  }

  onChange(listener: CommandTrailListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
