import { LogEntry } from './logParser';
import { extractSoqlFromRaw, parseCodeUnit, parseMethod } from './analysisModel';

/**
 * Call-tree / flame-chart builder. Takes the already-parsed LogEntry[] (the caller
 * parses the body once) and produces a flat list of nested spans that a webview
 * flame chart can lay out by depth + start/end nanos.
 */

export type SpanKind = 'CODE_UNIT' | 'METHOD' | 'SOQL' | 'DML' | 'CALLOUT';

export interface Span {
  id: number;
  parent: number | null;
  depth: number;              // 0 = root
  kind: SpanKind;
  label: string;              // short display label (truncated)
  detail: string;             // full text (full SOQL query etc.)
  startNanos: number;
  endNanos: number;
  lineNumber: number;         // opening entry's source line (for click-to-jump)
  truncated?: true;           // frame never closed (log truncated) — endNanos = last known nanos
}

export interface CallTreeResult {
  spans: Span[];
  totalNanos: number;
  spanCapHit: boolean;
}

/** Hard cap on emitted spans; a pathological/looping log won't blow up the webview. */
export const SPAN_CAP = 50_000;

/** Max label length; the full text is always preserved in `detail`. */
const LABEL_MAX = 120;

interface OpenFrame {
  span: Span;
}

/** BEGIN eventType -> [kind, matching END eventType]. */
const OPENERS: Record<string, { kind: SpanKind; end: string }> = {
  CODE_UNIT_STARTED: { kind: 'CODE_UNIT', end: 'CODE_UNIT_FINISHED' },
  METHOD_ENTRY: { kind: 'METHOD', end: 'METHOD_EXIT' },
  SOQL_EXECUTE_BEGIN: { kind: 'SOQL', end: 'SOQL_EXECUTE_END' },
  DML_BEGIN: { kind: 'DML', end: 'DML_END' },
  CALLOUT_REQUEST: { kind: 'CALLOUT', end: 'CALLOUT_RESPONSE' }
};

/** END eventType -> kind it closes. */
const CLOSERS: Record<string, SpanKind> = {
  CODE_UNIT_FINISHED: 'CODE_UNIT',
  METHOD_EXIT: 'METHOD',
  SOQL_EXECUTE_END: 'SOQL',
  DML_END: 'DML',
  CALLOUT_RESPONSE: 'CALLOUT'
};

export function buildCallTree(entries: LogEntry[]): CallTreeResult {
  const spans: Span[] = [];
  const stack: OpenFrame[] = [];
  let nextId = 0;
  let lastNanos = 0;      // monotonic carry-forward fallback for null timestampNanos
  let spanCapHit = false;
  let totalNanos = 0;

  const nanosOf = (e: LogEntry): number => {
    if (e.timestampNanos != null) lastNanos = e.timestampNanos;
    return lastNanos;
  };

  const closeSpan = (span: Span, endNanos: number, truncated: boolean) => {
    span.endNanos = Math.max(endNanos, span.startNanos);
    if (truncated) span.truncated = true;
    if (span.endNanos > totalNanos) totalNanos = span.endNanos;
  };

  for (const e of entries) {
    const opener = OPENERS[e.eventType];
    if (opener) {
      const now = nanosOf(e);
      if (spans.length >= SPAN_CAP) {
        // Cap reached: stop emitting new spans, but keep the (unchanged) stack so
        // already-open frames still close correctly and end times stay accurate.
        spanCapHit = true;
        continue;
      }
      const { label, detail } = describe(opener.kind, e);
      const parent = stack.length > 0 ? stack[stack.length - 1].span : null;
      const span: Span = {
        id: nextId++,
        parent: parent ? parent.id : null,
        depth: stack.length,
        kind: opener.kind,
        label,
        detail,
        startNanos: now,
        endNanos: now,
        lineNumber: e.lineNumber
      };
      spans.push(span);
      stack.push({ span });
      continue;
    }

    const closerKind = CLOSERS[e.eventType];
    if (closerKind) {
      const now = nanosOf(e);
      // Find the nearest open frame of the matching kind and close it, unwinding any
      // frames above it (they must have been left open by a truncated/garbled log).
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].span.kind === closerKind) { idx = i; break; }
      }
      if (idx === -1) continue; // stray close with no matching open frame — ignore
      // Close frames above the match as truncated (they never got their own close).
      for (let i = stack.length - 1; i > idx; i--) {
        closeSpan(stack[i].span, now, true);
      }
      closeSpan(stack[idx].span, now, false);
      stack.length = idx;
      continue;
    }

    // Any other timestamped entry still advances the monotonic clock so a later
    // truncation-close uses the freshest nanos we have seen.
    nanosOf(e);
  }

  // EOF: close everything still open as truncated at the last nanos we saw.
  for (let i = stack.length - 1; i >= 0; i--) {
    closeSpan(stack[i].span, lastNanos, true);
  }

  return { spans, totalNanos, spanCapHit };
}

function describe(kind: SpanKind, e: LogEntry): { label: string; detail: string } {
  switch (kind) {
    case 'CODE_UNIT': {
      const cu = parseCodeUnit(e);
      const full = cu.detail ? `${cu.className} — ${cu.detail}` : cu.className;
      // Non-trigger code units are usually "Class.method"; show it with parens.
      const label = cu.isTrigger ? full : (cu.detail ? `${cu.className}.${cu.detail}` : cu.className);
      return { label: truncate(label, LABEL_MAX), detail: full };
    }
    case 'METHOD': {
      const m = parseMethod(e);
      const sig = m.detail ? `${m.className}.${m.detail}()` : `${m.className}()`;
      return { label: truncate(sig, LABEL_MAX), detail: sig };
    }
    case 'SOQL': {
      const { query } = extractSoqlFromRaw(e);
      const q = query || e.message;
      return { label: truncate(q, LABEL_MAX), detail: q };
    }
    case 'DML': {
      const segments = e.message.split(' | ').map(s => s.trim());
      const op = (segments.find(s => /^Op:/i.test(s)) ?? '').replace(/^Op:/i, '').trim();
      const type = (segments.find(s => /^Type:/i.test(s)) ?? '').replace(/^Type:/i, '').trim();
      const label = [op, type].filter(Boolean).join(' ') || 'DML';
      return { label: truncate(label, LABEL_MAX), detail: e.message };
    }
    case 'CALLOUT': {
      // The callout descriptor is the last non-empty pipe segment (URL / service name).
      const segs = e.message.split(' | ').map(s => s.trim()).filter(Boolean);
      const label = segs[segs.length - 1] || 'Callout';
      return { label: truncate(label, LABEL_MAX), detail: e.message };
    }
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
