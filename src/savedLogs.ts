import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StoredLogMeta } from './logStore';

export interface SaveInput {
  body: string;
  meta: StoredLogMeta;
  summary?: string;
}

export interface SaveResult {
  wrote: boolean;
  logPath: string;
  metaPath: string;
  summaryPath?: string;
}

export class SavedLogsService {
  resolveFolder(folderSetting: string): string {
    const trimmed = (folderSetting || '').trim();
    if (!trimmed) {
      return path.join(os.homedir(), 'sf-saved-logs');
    }
    if (trimmed.startsWith('~')) {
      return path.join(os.homedir(), trimmed.slice(1));
    }
    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (workspace) {
      return path.join(workspace.uri.fsPath, trimmed);
    }
    return path.join(os.homedir(), trimmed);
  }

  async save(folderSetting: string, input: SaveInput): Promise<SaveResult> {
    const folder = this.resolveFolder(folderSetting);
    await fs.mkdir(folder, { recursive: true });
    const base = this.buildFileBase(input.meta);
    const logPath = await uniquePath(folder, `${base}.log`);
    const metaPath = logPath.replace(/\.log$/, '.meta.json');
    let summaryPath: string | undefined;
    let wrote = false;
    try {
      await fs.writeFile(logPath, input.body, 'utf8');
      await fs.writeFile(metaPath, JSON.stringify(input.meta, null, 2), 'utf8');
      if (input.summary) {
        summaryPath = logPath.replace(/\.log$/, '.summary.md');
        await fs.writeFile(summaryPath, input.summary, 'utf8');
      }
      wrote = true;
    } catch (err) {
      await fs.rm(logPath, { force: true });
      await fs.rm(metaPath, { force: true });
      if (summaryPath) await fs.rm(summaryPath, { force: true });
      throw err;
    }
    return { wrote, logPath, metaPath, summaryPath };
  }

  async saveExternal(folderSetting: string, sourcePath: string, body: string, summary?: string): Promise<SaveResult> {
    const folder = this.resolveFolder(folderSetting);
    await fs.mkdir(folder, { recursive: true });
    const stem = path.basename(sourcePath).replace(/\.[^.]+$/, '');
    const timestamp = formatTimestamp(new Date().toISOString());
    const base = sanitize(`${timestamp}_external_${stem}`);
    const logPath = await uniquePath(folder, `${base}.log`);
    await fs.writeFile(logPath, body, 'utf8');
    let summaryPath: string | undefined;
    if (summary) {
      summaryPath = logPath.replace(/\.log$/, '.summary.md');
      await fs.writeFile(summaryPath, summary, 'utf8');
    }
    return { wrote: true, logPath, metaPath: '', summaryPath };
  }

  private buildFileBase(meta: StoredLogMeta): string {
    const ts = formatTimestamp(meta.StartTime ?? meta.fetchedAt);
    const userName = (meta.LogUserName ?? meta.LogUserId ?? 'unknown').slice(0, 40);
    const operation = (meta.Operation ?? 'op').slice(0, 30);
    const shortId = (meta.Id || 'log').slice(-6);
    return sanitize(`${ts}_${userName}_${operation}_${shortId}`);
  }
}

function sanitize(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return formatTimestamp(new Date().toISOString());
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function uniquePath(folder: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(folder, name);
  let counter = 2;
  while (await exists(candidate)) {
    candidate = path.join(folder, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
