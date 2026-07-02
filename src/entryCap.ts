/**
 * Host-side cap on how many parsed log entries cross the webview postMessage
 * bridge in one message. A 20 MB Apex log parses to hundreds of thousands of
 * entries; posting the whole array on every row click is a huge structured
 * clone the webview only ever renders a couple of `renderLimit` chunks of. We
 * cap the array here and tell the webview it was truncated so it can offer the
 * full .log in an editor tab. Pure (no vscode import) so it's unit-testable.
 */

/** Max parsed entries posted across the bridge in one message. The webview
 *  renders in 2,000-row chunks with a "Show more" button; 5,000 gives a few
 *  chunks of headroom while keeping the clone bounded even for a multi-MB log. */
export const HOST_ENTRY_CAP = 5000;

/** Cap an entry array to `cap`, reporting whether it was truncated. Returns a
 *  fresh array (never the input) so callers can't mutate the source. */
export function capEntries<T>(
  entries: readonly T[],
  cap: number = HOST_ENTRY_CAP
): { entries: T[]; truncated: boolean } {
  if (entries.length <= cap) return { entries: entries.slice(), truncated: false };
  return { entries: entries.slice(0, cap), truncated: true };
}
