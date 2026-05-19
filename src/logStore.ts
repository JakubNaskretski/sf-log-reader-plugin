import * as vscode from 'vscode';
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
  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly folderName: string
  ) {}

  private rootDir(): string {
    return path.join(this.workspaceRoot.fsPath, this.folderName);
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
    for (const meta of metas.slice(0, count)) {
      const userId = meta.LogUserId ?? 'unknown';
      await fs.rm(this.logPath(meta.orgAlias!, userId, meta.Id), { force: true });
      await fs.rm(this.metaPath(meta.orgAlias!, userId, meta.Id), { force: true });
      removed += 1;
    }
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

function sanitize(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_');
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
