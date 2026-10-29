# Changelog

All notable changes to Packageawy are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.9.2] - 2026-10-29

### Fixed

- Transitive fixes in pnpm projects no longer stay on "Checking" when the fix reuses a version that is already installed.
- Likely-unused results come back after `package.json` or the lockfile changes, instead of staying cleared until a manual refresh.
- The Node version note and the Upgrade tooltip no longer name a specific editor.

## [0.9.1] - 2026-10-28

### Added

- A Packageawy icon in the Activity Bar that opens the dashboard with one click.

### Changed

- The display name is now "Packageawy: npm & pnpm Dependency Manager".

### Fixed

- Project discovery skips `.vscode-test` folders, so projects that test a VS Code extension no longer list the downloaded VS Code's own `package.json` files.

## [0.9.0] - 2026-10-21

First public pre-release.

### Added

- A dependency table for npm and pnpm projects with installed, wanted, and latest versions, update type, filters, and search by package, vulnerability ID, or dependency path.
- Monorepo support with a project picker for npm workspaces and pnpm importers.
- Vulnerability details across the whole dependency tree: severity, affected package, dependency path, GHSA and CVE links, and patched versions.
- Upgrade Review with peer, engine, export, and import checks, focused Next.js migration rules, and coordinated upgrade plans when peers conflict.
- Transitive fixes that move a vulnerable child package to a patched version without changing its direct parent.
- Removal Review, bulk dependency management, and Smart Cleanup for unused, deprecated, and duplicate packages.
- "Likely unused" detection that counts peer requirements, `@types/*` packages, and ESLint shorthand names such as `next/core-web-vitals` as usage.
- Safe changes: install scripts off by default, optional verification scripts, a visible VS Code task, and rollback of `package.json` and the lockfile.
- Cached results with background refresh and automatic reloads when dependency files or the Git branch change.

### Security

- Runs only in trusted workspaces.
- Rejects unresolved `${...}` values in project `.npmrc` registry settings and never stores auth tokens.
- Re-reads the project right before every change and refuses to roll back over edits made in the meantime.

[0.9.2]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.2
[0.9.1]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.1
[0.9.0]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.0
