# Contributing

## Workflow

1. Create a feature branch off `main` (e.g. `feat/log-summary-generator`, `fix/org-picker-crash`).
2. Commit using [Conventional Commits](https://www.conventionalcommits.org/) — see the format below.
3. Open a Pull Request against `main`.
4. CI runs commit linting + Claude PR review. Both must be green before merging.
5. Merge via PR only. **Direct pushes to `main` are not allowed.**

## Commit message format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Examples:

- `feat(panel): add bottom-panel webview with log list`
- `fix(cli): handle missing default org`
- `chore: bump @types/vscode`

Both individual commits and the PR title are linted in CI (`.github/workflows/commit-lint.yml`).

## Local development

```bash
npm install
npm run compile        # one-off build
npm run watch          # rebuild on save
npm test               # run vitest
```

Press `F5` in VS Code to launch a development host with the extension loaded.

## Releasing

Bump the version in `package.json`, tag, and package as `.vsix`:

```bash
npm version <patch|minor|major>
npx vsce package
```
