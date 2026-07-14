import * as fs from 'fs/promises';
import * as path from 'path';
import { ApexLogRecord } from './sfCliService';

export interface StoredLogMeta extends ApexLogRecord {
  orgUsername: string;
  orgAlias?: string;
  fetchedAt: string;
}

export interface FetchResult {
  saved: number;
  skipped: number;
  failures: Array<{ id: string; error: string }>;
}

export class LogStore {
  constructor(private readonly basePath: string) {}

  private rootDir(): string {
    return this.basePath;
  }

  private orgDir(orgAlias: string): string {
    return path.join(this.rootDir(), sanitize(orgAlias));
  }

  private userDir(orgAlias: string, userId: string): string {
    return path.join(this.orgDir(orgAlias), sanitize(userId));
  }

  logPath(orgAlias: string, userId: string, logId: string): string {
    return path.join(this.userDir(orgAlias, userId), `${sanitize(logId)}.log`);
  }

  metaPath(orgAlias: string, userId: string, logId: string): string {
    return path.join(this.userDir(orgAlias, userId), `${sanitize(logId)}.meta.json`);
  }

  summaryPath(orgAlias: string, userId: string, logId: string): string {
    return path.join(this.userDir(orgAlias, userId), `${sanitize(logId)}.summary.md`);
  }

  async writeSummary(orgAlias: string, userId: string, logId: string, markdown: string): Promise<string> {
    const target = this.summaryPath(orgAlias, userId, logId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, markdown, 'utf8');
    return target;
  }

  async summaryExists(orgAlias: string, userId: string, logId: string): Promise<boolean> {
    try {
      await fs.access(this.summaryPath(orgAlias, userId, logId));
      return true;
    } catch {
      return false;
    }
  }

  async exists(orgAlias: string, userId: string, logId: string): Promise<boolean> {
    try {
      await fs.access(this.logPath(orgAlias, userId, logId));
      return true;
    } catch {
      return false;
    }
  }

  async save(
    orgAlias: string,
    record: ApexLogRecord,
    body: string,
    orgUsername: string
  ): Promise<{ wrote: boolean; path: string }> {
    const userId = record.LogUserId ?? 'unknown';
    const logPath = this.logPath(orgAlias, userId, record.Id);
    if (await this.exists(orgAlias, userId, record.Id)) {
      return { wrote: false, path: logPath };
    }
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, body, 'utf8');
    const meta: StoredLogMeta = {
      ...record,
      orgUsername,
      orgAlias,
      fetchedAt: new Date().toISOString()
    };
    await fs.writeFile(this.metaPath(orgAlias, userId, record.Id), JSON.stringify(meta, null, 2), 'utf8');
    return { wrote: true, path: logPath };
  }

  async readBody(orgAlias: string, userId: string, logId: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.logPath(orgAlias, userId, logId), 'utf8');
    } catch {
      return undefined;
    }
  }

  async listStored(orgAlias: string): Promise<StoredLogMeta[]> {
    const dir = this.orgDir(orgAlias);
    const out: StoredLogMeta[] = [];
    let userDirs: string[];
    try {
      userDirs = await fs.readdir(dir);
    } catch {
      return [];
    }
    for (const userDir of userDirs) {
      const full = path.join(dir, userDir);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const files = await fs.readdir(full);
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue;
        try {
          const raw = await fs.readFile(path.join(full, file), 'utf8');
          const meta = JSON.parse(raw) as StoredLogMeta;
          out.push(meta);
        } catch {
          // skip corrupt meta
        }
      }
    }
    return out;
  }

  async storageBytes(orgAlias: string): Promise<number> {
    const dir = this.orgDir(orgAlias);
    return walkSize(dir);
  }

  async deleteOldest(orgAlias: string, count: number): Promise<number> {
    const metas = await this.listStored(orgAlias);
    metas.sort((a, b) => (a.fetchedAt ?? '').localeCompare(b.fetchedAt ?? ''));
    let removed = 0;
    let failed = 0;
    for (const meta of metas.slice(0, count)) {
      const userId = meta.LogUserId ?? 'unknown';
      // Per-entry isolation + one retry: Windows AV/indexers hold brief locks on
      // recently-written files (EBUSY/EPERM); one locked file must not abort the
      // whole sweep and strand half-deleted entries (orphan .meta.json renders
      // as a phantom log in listStored).
      try {
        await rmWithRetry(this.logPath(meta.orgAlias!, userId, meta.Id));
        await rmWithRetry(this.metaPath(meta.orgAlias!, userId, meta.Id));
        await rmWithRetry(this.summaryPath(meta.orgAlias!, userId, meta.Id));
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) throw new Error(`Deleted ${removed} log(s); ${failed} could not be removed (files may be locked — retry in a moment).`);
    return removed;
  }

  async deleteAll(orgAlias: string): Promise<void> {
    await fs.rm(this.orgDir(orgAlias), { recursive: true, force: true });
  }

  rootPath(): string {
    return this.rootDir();
  }

  orgPath(orgAlias: string): string {
    return this.orgDir(orgAlias);
  }
}

/** fs.rm with one delayed retry — Windows AV/indexer locks are transient; a
 *  single immediate failure shouldn't surface as a hard error. force:true keeps
 *  the ENOENT-tolerant semantics of the call sites this replaces. */
async function rmWithRetry(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch {
    await new Promise(r => setTimeout(r, 200));
    await fs.rm(target, { force: true });
  }
}

function sanitize(input: string): string {
  let cleaned = input.replace(/[^A-Za-z0-9._-]/g, '_');
  // Never allow a path segment that is "." or ".." (directory traversal) — a
  // crafted/garbage logId/userId/orgAlias must stay inside the store root.
  if (/^\.+$/.test(cleaned)) return '_'.repeat(cleaned.length);
  // Windows extras (org ALIASES are freeform user text): reserved device names
  // (CON, NUL, COM1…) are invalid path segments even with an extension; Win32
  // silently strips trailing dots (=> "acme" and "acme." would share a dir); and
  // an 80-char username-as-alias stacked under globalStorage can brush MAX_PATH.
  // Case is folded on win32 only — NTFS is case-insensitive, so "DevOrg" and
  // "devorg" were ALREADY one physical dir there; folding makes the code agree
  // with the filesystem (no migration risk: the plugin never worked on Windows
  // before this fix, so no existing Windows stores exist).
  cleaned = cleaned.replace(/\.+$/, '_');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > 64) cleaned = cleaned.slice(0, 64);
  if (process.platform === 'win32') cleaned = cleaned.toLowerCase();
  return cleaned || '_';
}

async function walkSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await walkSize(full);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // skip
      }
    }
  }
  return total;
}
