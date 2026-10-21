# Contributing

Thanks for helping improve Packageawy. Bug reports, focused feature proposals, documentation fixes, and tested pull requests are all welcome.

## Setup

You need VS Code 1.90 or newer and Node.js 22 or newer.

```bash
git clone https://github.com/Azzam-Aldulaylan/packageawy.git
cd packageawy
npm ci
npm run typecheck
npm test
```

To run the extension against a real project, follow [Testing in VS Code](docs/testing-in-vscode-extension-host.md).

## How the code is organized

- `src/core` holds the pure logic: lockfile parsing, the dependency graph, registry and advisory data, compatibility checks, upgrade planning, and usage scanning. It never imports `vscode` and never starts processes.
- `src/host` talks to VS Code: project discovery, Workspace Trust, file access, package-manager processes, transactions, and caching.
- `webview/src` is the React UI. It only displays data and sends requests. It never decides commands, paths, versions, or scripts. The host validates every message it receives.
- `src/extension.ts` only wires things together.

A few rules the code relies on:

- `unknown` is never treated as safe or compatible. Missing data stays visible as missing.
- Nothing changes on disk without a review step, a fresh re-read of the project, and a saved copy of `package.json` and the lockfile.
- Rollback refuses to overwrite files that changed after the transaction started.
- Cancellation is honored before any change starts. A running package manager is never killed while it may be writing files.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run test:real-projects
npm run test:extension-host
npm run build
git diff --check
```

- Put reusable logic in `src/core`, VS Code code in `src/host`, and UI in `webview/src`.
- Reuse existing components and VS Code theme variables before adding new styles.
- Add a test for every behavior change.
- Don't commit `dist`, `.vsix` files, credentials, temporary projects, or local editor settings.
- In the pull request, describe what users will see, any safety implications, and whether you tested with npm, pnpm, or both.

`test:real-projects` and the live advisory test need network access and run real package-manager commands. Use throwaway projects for them.

## Reporting security issues

Please don't report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.
