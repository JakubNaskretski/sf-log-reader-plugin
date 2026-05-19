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

export function parseLogs(raw: string): LogEntry[] {
  if (!raw) return [];
  const entries: LogEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^\d+\.\d+\s+\w/.test(trimmed) && trimmed.includes('APEX_CODE')) continue;
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx === -1) continue;
    const timestampField = trimmed.slice(0, pipeIdx);
    if (!/^\d{2}:\d{2}:\d{2}/.test(timestampField)) continue;
    const parts = trimmed.slice(pipeIdx + 1).split('|');
    const eventType = parts[0] ?? '';
    const lineRef = parts[1] ?? '';
    const message = parts.slice(2).join(' | ');
    entries.push({
      lineNumber: i + 1,
      timestamp: timestampField.split(' ')[0],
      category: CATEGORY_MAP[eventType] ?? 'SYSTEM',
      eventType,
      lineRef,
      message,
      raw: trimmed
    });
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
