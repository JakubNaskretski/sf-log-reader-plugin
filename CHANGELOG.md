# Changelog

All notable changes to the SF Log Reader extension are documented here.
This file starts at the current release; earlier history predates it.

## 0.7.2

- Fixed: **Duplicate lookups collapsed.** Opening the panel while picking an org — or
  switching the shared org from another Skrety plugin — could spawn several identical
  `sf` list processes at once. Org and user lookups now share one in-flight call, so a
  burst of triggers costs a single process.

## 0.7.1

- Fixed: **No more silent failures.** A panel click or a command (org/user pick, refresh,
  fetch, capture, …) that hit an error could previously do nothing at all, with no message
  anywhere. Every failure now shows an error notification with a **Show Output** button and
  is logged to the output channel.

## 0.7.0

- **Timeline flame chart.** A new Timeline tab in the log detail pane draws the
  transaction as a flame chart — code units, methods, SOQL, DML, and callouts as
  nested time bars. Ctrl+wheel (or pinch) zooms around the cursor, drag pans,
  hovering shows durations and details, and clicking a bar jumps to that line in
  the log view. Logs cut off by the 20 MB cap render with their open frames
  marked as truncated.
- **Analysis tab.** Governor-limit usage bars (with warning colors as you
  approach a limit), observed SOQL/DML/callout counts, per-query timings with
  row counts, a DML breakdown, hottest methods, and per-class/trigger
  attribution — all computed from the log without leaving the panel.
- **Profiling capture preset.** Start Capturing now offers "Standard" or
  "Profiling (FINEST)". The profiling preset records method-level detail so the
  Timeline can show method bars — note logs get much larger. Method detail only
  appears for class/trigger code; anonymous Apex never emits it.
- The markdown summary and the new tabs now share one analysis engine, so their
  numbers always agree.

## 0.6.0

- **Start Capturing.** A toolbar button ensures a debug TraceFlag for the
  selected user on the org, so new logs actually get generated — no more manual
  Setup trips. The optional `sfLogReader.autoTraceFlag` setting (off by
  default) does this automatically before each fetch.
- **User filter now applies on the org.** With a log user selected, the org
  query filters server-side, so that user's logs are found even in busy orgs
  where they would fall outside the newest-N window.
- Very large logs cap what is sent to the panel (first 5,000 entries) with a
  notice and a one-click "open the full log in an editor" escape hatch.
- Switching orgs from the command palette no longer shows the previous org's
  user list, and palette commands work before the panel has been opened.
- The selected org is now shared with the other Skrety Salesforce extensions —
  switch once, it applies everywhere.
- Windows: the `sf` launcher is resolved directly instead of through the shell,
  and "CLI not found" is no longer reported spuriously when CLI plugins print
  warnings.

## 0.5.0

- **Much faster fetch.** Log lists and bodies now download over the Salesforce
  REST API directly (one cached session per org) instead of spawning an `sf`
  CLI process per log, cutting a typical 25-log fetch from ~20s to a few
  seconds. The CLI path remains as an automatic fallback.
- **Progressive log list.** The list renders immediately after the org query —
  newest logs at the top — with per-row "downloading…" badges that resolve as
  bodies stream in. Clicking a pending row bumps it to the front of the queue
  and opens it the moment it lands.
- Fetch is now guarded against double-starts; the button reflects the running
  state.
- Large-log viewer performance: entries render in chunks with a "Show more"
  control, search input is debounced, and oversized logs are no longer
  serialized into webview state on every keystroke.
- Windows: `sf` is now launched through the shell (the `sf.cmd` shim cannot be
  spawned directly on modern Node), fixing a false "CLI not found" error.
- `sfLogReader.apiVersion` now applies to the REST calls when set explicitly;
  otherwise the org's default API version is used.

## 0.4.3

- Add a branded extension icon — shown on the Marketplace listing and the editor panel.

## 0.4.2

- Internal packaging and tooling cleanup. No functional changes.

## 0.4.1

- Browse, fetch, and filter Salesforce debug logs from any authenticated org,
  surfaced in a bottom-panel webview.
