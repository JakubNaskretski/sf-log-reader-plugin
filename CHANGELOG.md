# Changelog

All notable changes to the SF Log Reader extension are documented here.
This file starts at the current release; earlier history predates it.

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
