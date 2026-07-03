import { LogEntry, parseLogs } from './logParser';

/**
 * Shared data layer for the log analysis features. Both the markdown summary
 * generator (summaryGenerator.ts) and the webview Analysis tab consume this
 * module, so the collector logic lives here exactly once.
 */

export interface Frame {
  id: number;
  parent: number | null;
  className: string;
  detail: string;
  enteredAt: string;
  enteredNanos: number | null;
  exitedNanos: number | null;
  soql: number;
  dml: number;
  callouts: number;
  exceptions: string[];
  isTrigger: boolean;
}

export interface ClassStats {
  className: string;
  soql: number;
  dml: number;
  callouts: number;
  exceptions: number;
  enters: number;
  totalNanos: number;
  isTrigger: boolean;
  detail: string;
}

export interface SoqlTiming {
  lineRef: string;
  query: string;
  rows?: number;
  aggregations?: string;
  durationMs?: number;
}

export interface DmlOp {
  op: string;
  type: string;
  count: number;
  rows: number;
}

export interface MethodCount {
  signature: string;
  enters: number;
}

export interface LimitMetric {
  name: string;
  used: number;
  max: number;
}

export interface ObservedCounts {
  soqlQueries: number;
  soqlRows: number;
  soslQueries: number;
  dmlStatements: number;
  dmlRows: number;
  callouts: number;
  asyncJobsEnqueued: number;
  publishImmediateEvents: number;
}

export interface LimitException {
  message: string;
  metric?: string;
  value?: number;
  cap?: number;
  lineRef: string;
}

export const TRIGGER_EVENT_RE = /\btrigger event\b/i;
export const CODE_UNIT_TRIGGER_RE = /^([^|]+?)\s+on\s+([^|]+?)\s+trigger event\s+([A-Za-z]+)/i;

export interface AnalysisPayload {
  totalElapsedMs: number | null;
  observed: ObservedCounts;
  limits: LimitMetric[];
  limitExceptions: LimitException[];
  soqlTimings: SoqlTiming[];
  dmlBreakdown: DmlOp[];
  hottestMethods: MethodCount[];
  classStats: ClassStats[];
}

/**
 * One-shot analysis of a raw log body: everything the Analysis tab needs, without
 * the markdown formatting. Parses the body once and runs every collector over it.
 */
export function buildAnalysis(body: string): AnalysisPayload {
  const entries = parseLogs(body);
  const { byClass } = walk(entries);
  const soqlTimings = collectSoqlTimings(entries);
  const dmlBreakdown = collectDmlBreakdown(entries);
  const hottestMethods = collectHottestMethods(entries, 15);
  const observed = collectObservedCounts(entries, soqlTimings, dmlBreakdown);
  const limits = parseLimits(body);
  const limitExceptions = collectLimitExceptions(entries);
  const totalElapsedMs = computeTotalElapsedMs(entries);
  const classStats = Array.from(byClass.values()).sort((a, b) => b.totalNanos - a.totalNanos);
  return {
    totalElapsedMs: totalElapsedMs ?? null,
    observed,
    limits,
    limitExceptions,
    soqlTimings,
    dmlBreakdown,
    hottestMethods,
    classStats
  };
}

export function walk(entries: LogEntry[]): {
  frames: Frame[];
  byClass: Map<string, ClassStats>;
  edgeCalls: Map<string, Map<string, number>>;
} {
  const frames: Frame[] = [];
  const stack: number[] = [];
  const byClass = new Map<string, ClassStats>();
  const edgeCalls = new Map<string, Map<string, number>>();
  let nextId = 0;

  const ensureClassStats = (className: string, isTrigger: boolean, detail: string): ClassStats => {
    let s = byClass.get(className);
    if (!s) {
      s = { className, soql: 0, dml: 0, callouts: 0, exceptions: 0, enters: 0, totalNanos: 0, isTrigger, detail };
      byClass.set(className, s);
    } else {
      if (isTrigger) s.isTrigger = true;
      if (detail && !s.detail) s.detail = detail;
    }
    return s;
  };

  const recordEdge = (parentId: number, childClass: string) => {
    const parent = frames[parentId];
    if (!parent || parent.className === childClass) return;
    let map = edgeCalls.get(parent.className);
    if (!map) {
      map = new Map();
      edgeCalls.set(parent.className, map);
    }
    map.set(childClass, (map.get(childClass) ?? 0) + 1);
  };

  const push = (className: string, detail: string, entry: LogEntry, isTrigger: boolean) => {
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const frame: Frame = {
      id: nextId++,
      parent,
      className,
      detail,
      enteredAt: entry.timestamp,
      enteredNanos: entry.timestampNanos,
      exitedNanos: null,
      soql: 0,
      dml: 0,
      callouts: 0,
      exceptions: [],
      isTrigger
    };
    frames.push(frame);
    stack.push(frame.id);
    const stats = ensureClassStats(className, isTrigger, detail);
    stats.enters += 1;
    if (parent != null) recordEdge(parent, className);
  };

  const pop = (entry: LogEntry) => {
    const id = stack.pop();
    if (id == null) return;
    const frame = frames[id];
    frame.exitedNanos = entry.timestampNanos;
    if (frame.enteredNanos != null && frame.exitedNanos != null) {
      const dur = frame.exitedNanos - frame.enteredNanos;
      if (dur > 0) {
        const stats = byClass.get(frame.className);
        if (stats) stats.totalNanos += dur;
      }
    }
  };

  const top = (): Frame | undefined => (stack.length > 0 ? frames[stack[stack.length - 1]] : undefined);
  const attribute = (mut: (s: ClassStats, f: Frame) => void) => {
    const f = top();
    if (!f) return;
    const s = byClass.get(f.className);
    if (!s) return;
    mut(s, f);
  };

  for (const e of entries) {
    switch (e.eventType) {
      case 'CODE_UNIT_STARTED': {
        const parsed = parseCodeUnit(e);
        push(parsed.className, parsed.detail, e, parsed.isTrigger);
        break;
      }
      case 'CODE_UNIT_FINISHED':
        pop(e);
        break;
      case 'METHOD_ENTRY': {
        const parsed = parseMethod(e);
        push(parsed.className, parsed.detail, e, false);
        break;
      }
      case 'METHOD_EXIT':
        pop(e);
        break;
      case 'SOQL_EXECUTE_BEGIN':
        attribute((s, f) => { s.soql += 1; f.soql += 1; });
        break;
      case 'DML_BEGIN':
        attribute((s, f) => { s.dml += 1; f.dml += 1; });
        break;
      case 'CALLOUT_REQUEST':
        attribute((s, f) => { s.callouts += 1; f.callouts += 1; });
        break;
      case 'EXCEPTION_THROWN':
      case 'FATAL_ERROR':
        attribute((s, f) => { s.exceptions += 1; f.exceptions.push(e.message); });
        break;
    }
  }

  return { frames, byClass, edgeCalls };
}

/** Exported for tests and for callTree's trigger detection. */
export function parseCodeUnit(entry: LogEntry): { className: string; detail: string; isTrigger: boolean } {
  const parts = entry.message.split(' | ').map(s => s.trim()).filter(Boolean);
  // Triggers: the descriptor "<Name> on <SObject> trigger event <Phase>" can sit
  // in any segment — the LAST segment is usually the "__sfdc_trigger/<Name>" marker.
  // Search for the descriptor rather than assuming it's the last segment.
  const triggerSeg = parts.find(p => TRIGGER_EVENT_RE.test(p));
  if (triggerSeg) {
    const m = triggerSeg.match(CODE_UNIT_TRIGGER_RE);
    if (m) return { className: m[1].trim(), detail: `${m[3]} on ${m[2].trim()}`, isTrigger: true };
    const first = triggerSeg.split(/\s+/)[0] ?? triggerSeg;
    return { className: first, detail: triggerSeg, isTrigger: true };
  }
  // Fall back to the trigger name from a "__sfdc_trigger/<Name>" marker segment.
  const marker = parts.find(p => /^__sfdc_trigger\//.test(p));
  if (marker) {
    return { className: marker.replace(/^__sfdc_trigger\//, ''), detail: '', isTrigger: true };
  }
  const candidate = parts[parts.length - 1] ?? '';
  const dot = candidate.indexOf('.');
  if (dot > 0) return { className: candidate.slice(0, dot), detail: candidate.slice(dot + 1), isTrigger: false };
  return { className: candidate || '(anonymous)', detail: '', isTrigger: false };
}

export function parseMethod(entry: LogEntry): { className: string; detail: string } {
  const parts = entry.message.split(' | ').map(s => s.trim()).filter(Boolean);
  const candidate = parts[parts.length - 1] ?? '';
  const parenIdx = candidate.indexOf('(');
  const signature = parenIdx >= 0 ? candidate.slice(0, parenIdx) : candidate;
  const dot = signature.lastIndexOf('.');
  if (dot > 0) return { className: signature.slice(0, dot), detail: signature.slice(dot + 1) };
  return { className: signature || '(anonymous)', detail: '' };
}

export function collectObservedCounts(entries: LogEntry[], soqlTimings: SoqlTiming[], dmlBreakdown: DmlOp[]): ObservedCounts {
  const counts: ObservedCounts = {
    soqlQueries: 0,
    soqlRows: 0,
    soslQueries: 0,
    dmlStatements: 0,
    dmlRows: 0,
    callouts: 0,
    asyncJobsEnqueued: 0,
    publishImmediateEvents: 0
  };
  for (const e of entries) {
    switch (e.eventType) {
      case 'SOQL_EXECUTE_BEGIN': counts.soqlQueries += 1; break;
      case 'SOSL_EXECUTE_BEGIN': counts.soslQueries += 1; break;
      case 'DML_BEGIN': counts.dmlStatements += 1; break;
      case 'CALLOUT_REQUEST': counts.callouts += 1; break;
      case 'EVENT_SERVICE_PUB_DETAIL': counts.publishImmediateEvents += 1; break;
      case 'ASYNC_OPERATION_INSERTED': counts.asyncJobsEnqueued += 1; break;
    }
  }
  for (const t of soqlTimings) if (t.rows != null) counts.soqlRows += t.rows;
  for (const d of dmlBreakdown) counts.dmlRows += d.rows;
  return counts;
}

export function collectLimitExceptions(entries: LogEntry[]): LimitException[] {
  const out: LimitException[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.eventType !== 'EXCEPTION_THROWN' && e.eventType !== 'FATAL_ERROR') continue;
    // Message can now include an appended stack trace — match against the header line only.
    const header = e.message.split('\n', 1)[0];
    if (!/LimitException/i.test(header)) continue;
    const dedupeKey = `${e.lineRef}|${header.trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    // Strip the "System.LimitException:" prefix, then peel off an optional "<metric>: <value>[ out of <cap>]" tail.
    const stripped = header.replace(/^.*?LimitException:\s*/i, '').trim();
    const m = stripped.match(/^(.+?)(?::\s*(\d+)(?:\s+out of\s+(\d+))?)?\s*$/i);
    if (m) {
      out.push({
        message: header,
        metric: m[1].trim(),
        value: m[2] ? Number(m[2]) : undefined,
        cap: m[3] ? Number(m[3]) : undefined,
        lineRef: e.lineRef
      });
    } else {
      out.push({ message: header, lineRef: e.lineRef });
    }
  }
  return out;
}

/**
 * Extract the SOQL text (and Aggregations field) from a SOQL_EXECUTE_BEGIN line.
 * The query itself can contain `|` (e.g. `WHERE Name = 'a|b'`), so we read it
 * verbatim from the raw line rather than splitting on `|` and taking a segment.
 * Exported for tests.
 */
export function extractSoqlFromRaw(entry: LogEntry): { query: string; aggregations?: string } {
  const firstLine = entry.raw.split('\n', 1)[0];
  const fields = firstLine.split('|'); // [ts, EVENT, lineRef, Aggregations:N, ...query]
  const aggIdx = fields.findIndex(f => /^\s*Aggregations:/i.test(f));
  if (aggIdx >= 0) {
    return { aggregations: fields[aggIdx].trim(), query: fields.slice(aggIdx + 1).join('|').trim() };
  }
  return { query: fields.slice(3).join('|').trim() };
}

export function collectSoqlTimings(entries: LogEntry[]): SoqlTiming[] {
  const stack: Array<{ index: number; entry: LogEntry; query: string; aggregations?: string }> = [];
  const out: SoqlTiming[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.eventType === 'SOQL_EXECUTE_BEGIN') {
      const { query, aggregations } = extractSoqlFromRaw(e);
      stack.push({ index: i, entry: e, query, aggregations });
    } else if (e.eventType === 'SOQL_EXECUTE_END') {
      const open = stack.pop();
      if (!open) continue;
      const segments = e.message.split(' | ').map(s => s.trim()).filter(Boolean);
      const rowsField = segments.find(s => /^Rows:/i.test(s));
      const rows = rowsField ? Number(rowsField.replace(/^Rows:/i, '')) : undefined;
      const durationMs =
        open.entry.timestampNanos != null && e.timestampNanos != null
          ? Math.max(0, (e.timestampNanos - open.entry.timestampNanos) / 1_000_000)
          : undefined;
      out.push({
        lineRef: open.entry.lineRef,
        query: open.query,
        aggregations: open.aggregations,
        rows: Number.isFinite(rows) ? rows : undefined,
        durationMs
      });
    }
  }
  return out.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
}

export function collectDmlBreakdown(entries: LogEntry[]): DmlOp[] {
  const bucket = new Map<string, DmlOp>();
  for (const e of entries) {
    if (e.eventType !== 'DML_BEGIN') continue;
    const segments = e.message.split(' | ').map(s => s.trim());
    const op = (segments.find(s => /^Op:/i.test(s)) ?? 'Op:Unknown').replace(/^Op:/i, '');
    const type = (segments.find(s => /^Type:/i.test(s)) ?? 'Type:?').replace(/^Type:/i, '');
    const rowsField = segments.find(s => /^Rows:/i.test(s));
    const rows = rowsField ? Number(rowsField.replace(/^Rows:/i, '')) : 0;
    const key = `${op} ${type}`;
    const cur = bucket.get(key) ?? { op, type, count: 0, rows: 0 };
    cur.count += 1;
    cur.rows += Number.isFinite(rows) ? rows : 0;
    bucket.set(key, cur);
  }
  return Array.from(bucket.values()).sort((a, b) => b.rows - a.rows || b.count - a.count);
}

export function collectHottestMethods(entries: LogEntry[], limit: number): MethodCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.eventType !== 'METHOD_ENTRY') continue;
    const segs = e.message.split(' | ').map(s => s.trim()).filter(Boolean);
    const candidate = segs[segs.length - 1] ?? '';
    const sig = candidate.replace(/\(.*$/, '').trim();
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([signature, enters]) => ({ signature, enters }))
    .sort((a, b) => b.enters - a.enters)
    .slice(0, limit);
}

/** Exported for tests. */
export function parseLimits(raw: string): LimitMetric[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  let inBlock = false;
  let ns = '';
  // Key by namespace + metric so a managed package's LIMIT_USAGE_FOR_NS block does
  // not overwrite the (default) namespace's metrics (they share metric names).
  const latest = new Map<string, LimitMetric>();
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const nsMatch = line.match(/\|LIMIT_USAGE_FOR_NS\|([^|]*)\|/) || line.trim().match(/^LIMIT_USAGE_FOR_NS\|([^|]*)\|/);
    if (nsMatch) {
      inBlock = true;
      ns = (nsMatch[1] ?? '').trim();
      continue;
    }
    if (!inBlock) continue;
    const trimmed = line.trim();
    if (!trimmed) { inBlock = false; continue; }
    if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) { inBlock = false; continue; }
    const m = trimmed.match(/^(.+?):\s*(\d+)\s+out of\s+(\d+)/i);
    if (m) {
      const metric = m[1].replace(/^Number of\s+/i, '').trim();
      const isDefault = !ns || /^\(default\)$/i.test(ns);
      const name = isDefault ? metric : `${ns}: ${metric}`;
      latest.set(name, { name, used: Number(m[2]), max: Number(m[3]) });
    }
  }
  return Array.from(latest.values()).sort((a, b) => percent(b) - percent(a));
}

export function percent(m: LimitMetric): number {
  return m.max > 0 ? m.used / m.max : 0;
}

export function computeTotalElapsedMs(entries: LogEntry[]): number | undefined {
  const first = entries.find(e => e.timestampNanos != null);
  const last = [...entries].reverse().find(e => e.timestampNanos != null);
  if (!first || !last || first === last) return undefined;
  return Math.max(0, ((last.timestampNanos ?? 0) - (first.timestampNanos ?? 0)) / 1_000_000);
}
