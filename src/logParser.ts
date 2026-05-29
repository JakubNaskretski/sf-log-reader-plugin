export type LogCategory =
  | 'USER_DEBUG'
  | 'SOQL'
  | 'DML'
  | 'EXCEPTION'
  | 'CALLOUT'
  | 'CODE_UNIT'
  | 'METHOD'
  | 'LIMITS'
  | 'SYSTEM';

export interface LogEntry {
  lineNumber: number;
  timestamp: string;
  timestampNanos: number | null;
  category: LogCategory;
  eventType: string;
  lineRef: string;
  message: string;
  raw: string;
}

const CATEGORY_MAP: Record<string, LogCategory> = {
  USER_DEBUG: 'USER_DEBUG',
  SOQL_EXECUTE_BEGIN: 'SOQL',
  SOQL_EXECUTE_END: 'SOQL',
  SOQL_EXECUTE_EXPLAIN: 'SOQL',
  SOSL_EXECUTE_BEGIN: 'SOQL',
  SOSL_EXECUTE_END: 'SOQL',
  DML_BEGIN: 'DML',
  DML_END: 'DML',
  EXCEPTION_THROWN: 'EXCEPTION',
  FATAL_ERROR: 'EXCEPTION',
  CALLOUT_REQUEST: 'CALLOUT',
  CALLOUT_RESPONSE: 'CALLOUT',
  CODE_UNIT_STARTED: 'CODE_UNIT',
  CODE_UNIT_FINISHED: 'CODE_UNIT',
  METHOD_ENTRY: 'METHOD',
  METHOD_EXIT: 'METHOD',
  LIMIT_USAGE: 'LIMITS',
  LIMIT_USAGE_FOR_NS: 'LIMITS'
};

export interface LogStats {
  total: number;
  byCategory: Record<LogCategory, number>;
  byEventType: Record<string, number>;
}

const LINE_REF_RE = /^\[.+\]$/;

export function parseLogs(raw: string): LogEntry[] {
  if (!raw) return [];
  const entries: LogEntry[] = [];
  const lines = raw.split('\n');
  let last: LogEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^\d+\.\d+\s+\w/.test(trimmed) && trimmed.includes('APEX_CODE')) continue;
    const pipeIdx = trimmed.indexOf('|');
    const timestampField = pipeIdx === -1 ? '' : trimmed.slice(0, pipeIdx);
    const isNewEntry = pipeIdx !== -1 && /^\d{2}:\d{2}:\d{2}/.test(timestampField);
    if (!isNewEntry) {
      // Continuation line — Salesforce emits multi-line bodies (stack traces under
      // FATAL_ERROR, LIMIT_USAGE_FOR_NS body, variable dumps, etc.) on untimestamped
      // follow-up lines. Attach them to the previous entry instead of dropping.
      if (last) {
        last.message = last.message ? `${last.message}\n${trimmed}` : trimmed;
        last.raw = `${last.raw}\n${trimmed}`;
      }
      continue;
    }
    const parts = trimmed.slice(pipeIdx + 1).split('|');
    const eventType = parts[0] ?? '';
    const rest = parts.slice(1);
    // Some events (FATAL_ERROR, anonymous CODE_UNITs) have no [N] line ref segment.
    // Only treat parts[1] as the lineRef if it actually looks like one.
    let lineRef = '';
    let message: string;
    if (rest.length > 0 && LINE_REF_RE.test(rest[0])) {
      lineRef = rest[0];
      message = rest.slice(1).join(' | ');
    } else {
      message = rest.join(' | ');
    }
    const nanoMatch = timestampField.match(/\((\d+)\)/);
    const entry: LogEntry = {
      lineNumber: i + 1,
      timestamp: timestampField.split(' ')[0],
      timestampNanos: nanoMatch ? Number(nanoMatch[1]) : null,
      category: CATEGORY_MAP[eventType] ?? 'SYSTEM',
      eventType,
      lineRef,
      message,
      raw: trimmed
    };
    entries.push(entry);
    last = entry;
  }
  return entries;
}

export function summarize(entries: LogEntry[]): LogStats {
  const byCategory: Record<LogCategory, number> = {
    USER_DEBUG: 0, SOQL: 0, DML: 0, EXCEPTION: 0, CALLOUT: 0,
    CODE_UNIT: 0, METHOD: 0, LIMITS: 0, SYSTEM: 0
  };
  const byEventType: Record<string, number> = {};
  for (const e of entries) {
    byCategory[e.category] += 1;
    byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
  }
  return { total: entries.length, byCategory, byEventType };
}
