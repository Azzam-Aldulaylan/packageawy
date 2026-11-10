# Changelog

All notable changes to Packageawy are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- When no verification scripts are set, reviews for upgrades, removals, and transitive fixes list the project's `typecheck`, `build`, `test`, and `lint` scripts as checkboxes. Checked scripts run after that change, with the same Rollback choice if one fails. Scripts that watch files or start a server are not listed.
- "Remember for this project" saves the checked scripts as the project's verification scripts. In JetBrains IDEs they appear under Settings, Tools, Packageawy, Project.
- Right-click a `package.json` in the file tree or on its editor tab and choose **Open in Packageawy** to open the dashboard on that project. This works in VS Code and JetBrains IDEs.

## [0.9.4] - 2026-11-02

### Changed

- The dashboard header shows the Packageawy logo.
- Smart Cleanup no longer calls a finished plan "partially ready" when it only holds back automatic deduplication. The reason now appears in the Duplicate versions section.

### Fixed

- "Likely unused" now counts packages named in Prettier, Stylelint, commitlint, and lint-staged config files, and commands run from Husky git hooks.
- A `@scope/cli` package now counts as used when its command runs under the scope name, as `@commitlint/cli` runs as `commitlint`.
- `sharp` is no longer reported as unused in Next.js projects, since Next.js loads it for image optimization.

## [0.9.3] - 2026-11-01

### Changed

- New icon: a package with a code prompt, used for the Marketplace, the Activity Bar and the JetBrains plugin.

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

[0.9.4]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.4
[0.9.3]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.3
[0.9.2]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.2
[0.9.1]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.1
[0.9.0]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.0
