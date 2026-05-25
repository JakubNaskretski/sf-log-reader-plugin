# SF Log Reader

A VS Code extension that surfaces Salesforce debug logs in a bottom-panel webview. Pick an org and a user, fetch the latest logs from the org, filter by event type or text, and inspect each log inline — without leaving the editor.

## Features

- **Bottom panel webview** — opens next to the Terminal/Problems panel, not a sidebar.
- **Multi-org support** — discovers all authenticated `sf` orgs and remembers the selected one.
- **User filter** — fetch logs only for a specific user (yourself or someone else with logs in the org).
- **Local cache, no overwrite** — by default downloaded logs live in the extension's private global storage (partitioned per workspace), so they never clutter your workspace or git. Set `sfLogReader.logFolderName` to a path (workspace-relative, absolute, or `~`-prefixed) if you'd rather keep them next to your code. Existing logs are never overwritten; old logs are preserved until you explicitly delete them.
- **Storage cap** — a soft cap (`sfLogReader.maxStorageMB`) triggers a cleanup prompt when local logs grow past the threshold.
- **Filter row** — toggle event-type categories (USER_DEBUG, SOQL, DML, EXCEPTION, …) and free-text-search the active log.
- **Collapsible "SF CLI Command Log"** — every `sf` invocation made by the extension is recorded with its args, duration, and exit code, so you can see exactly what was run and why.

## Requirements

- VS Code 1.105 or later.
- The Salesforce CLI (`sf`) installed and on your `PATH`.
- At least one authenticated org (`sf org login web`).

## Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `sfLogReader.fetchLimit` | `25` | Max logs to list/fetch per refresh. |
| `sfLogReader.maxStorageMB` | `200` | Soft cap on per-org local log storage. |
| `sfLogReader.logFolderName` | `""` (global storage) | Where fetched logs are stored. Blank = extension's private global storage, partitioned per workspace. Accepts workspace-relative, absolute, or `~`-prefixed paths. |
| `sfLogReader.savedLogsFolder` | `""` (`~/sf-saved-logs`) | Where "Keep" copies logs. Same path rules as above. |
| `sfLogReader.commandTimeoutMs` | `60000` | Timeout per `sf` CLI invocation. |
| `sfLogReader.apiVersion` | `60.0` | API version (reserved for future Tooling API use). |

## Roadmap

- Offline summary generator: per-log Markdown report with a Mermaid class-call diagram and SOQL/DML counts.
- Cross-log analytics across a session.
- Quick "open in editor" for fetched `.log` files.

## License

MIT.
