# Changelog

All notable changes to Packageawy are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Keep your chosen upgrade version when refreshing the same dependency, while that version remains eligible.
- Pause dependency changes and offer Show Log and Reload if the dashboard receives an unrecognized host message.
- Keep results current when dependency scans overlap a successful or failed reload.

### Added

- After a successful dependency file restore with a lockfile, Packageawy offers to reinstall node_modules with npm ci or pnpm install --frozen-lockfile. Reinstall results are reported separately from the file restore.
- A long dependency change now shows Still running, explaining why Packageawy waits for the package manager before allowing another change or a rollback.
- If VS Code or a JetBrains IDE closes during a dependency change, Packageawy now keeps a recovery record in the project and offers to restore each file the next time you open it.

### Changed

- Rollback restores your dependency files and stops if it sees they changed. It checks all files before starting and keeps saved and displaced files until you remove them.
- Likely-unused results and Smart Cleanup now read the script blocks of Vue, Svelte and Astro files, and .mts and .cts files, so packages used only there are no longer suggested for removal.
- When a project has files Packageawy does not read yet, such as .mdx, removals are not recommended automatically and the screen says why.
- Cleanup checks now recognize more framework and tool config files, and package names in package.json tool settings.
- Packageawy now finds the lockfile your package manager will write, including the workspace root's, and uses it for every change and rollback.
- The Vulnerabilities column now reads No known vulnerabilities instead of Safe, which is exactly what was checked.

### Fixed

- Upgrades and removals no longer pause the editor while finding npm or pnpm.

- Transitive fix analysis now stops after two minutes if the isolated package manager is still working, including children that keep its output open, and reports that project files were not changed.
- A dependency change whose result was lost now shows the same blocked message in the dashboard and reviews, including Smart Cleanup, with a button to open recovery and no unverified restoration claims.
- Restart in JetBrains IDEs now waits for the engine to confirm that no dependency change is running or has an unknown outcome, blocks new changes during that check, and ignores repeated requests from finished restart attempts.
- Changing package.json or the lockfile while a scan is running no longer lets the dashboard reuse the older results as if they were current.
- In a workspace where the lockfile sits above the opened folder, changes are now turned off with the reason shown, instead of rewriting a file Packageawy could not restore.
- Vulnerability checks for update versions keep working after an internal error, instead of stopping until the dashboard is refreshed.
- Internal errors now appear in the dashboard with a Show Log button. An error during a dependency change keeps its recovery files and blocks further changes until recovery. Unrelated background errors let the change finish and pause new changes until you reopen the panel. Refresh and reviews keep working.
- An unhandled internal error in the JetBrains engine now blocks dependency changes until the engine restarts, including after closing and reopening the panel. Read-only scans can continue.
- Opening a file, a link or Settings from Packageawy now says so when the editor could not open it, and the Packageawy log records the failure.
- An install or check that finishes immediately no longer leaves the project waiting and locked in VS Code.
- A confirmed upgrade, removal or Smart Cleanup restore that stops before changing any files, because the Packageawy view reloaded, now says so instead of waiting with no answer.

## [0.9.7] - 2026-11-12

### Added

- A Packageawy log records registry and npm audit failures, to help with troubleshooting. It names the package, the registry host and the kind of failure only. In VS Code, open it with Packageawy: Show Log. In JetBrains IDEs, the lines are in the IDE log.

### Changed

- When an upgrade is offered, the Available column shows the version the Upgrade button installs. When latest-version information is available and differs, the latest is shown under it.
- The upgrade version list shows a short tag for vulnerable versions, for example 3 vulnerabilities (high). The full details for the selected version appear on hover, focus or click on the warning beside the list.
- When the upgrade version list cannot load, it says why (for example, the registry timed out or needs sign-in) and offers Retry, or Refresh when the project changed. If the full list fails, the tagged releases are shown instead.
- The partial results message says what is missing and what to do, for example No package-lock.json found. Run npm install, then refresh. When update checks fail, it points to the Packageawy log for the reason.

### Fixed

- The vulnerability warning in the Available column now follows the suggested upgrade version. The installed version is no longer marked there.
- A registry response saved in the cache that could not be read is now replaced automatically instead of failing every time.
- When a registry is configured with http://, the Packageawy log now says so instead of reporting a generic failure. Packageawy only connects to registries over https.
- The upgrade review no longer says there is no newer version when the version check failed or the package has no installed version. It says what happened, and offers Refresh where trying again can help.
- The Updates card no longer reads Up to date when some packages were not checked, for example in a project without a lockfile.

## [0.9.6] - 2026-11-11

### Changed

- The dashboard opens faster on a project without saved results. VS Code starts reading the project as soon as the panel opens, exact version pins on the public npm registry are confirmed with one small request instead of the full version list, and fixed versions for vulnerable packages are looked up as soon as the vulnerability results arrive.

### Fixed

- Upgrade reviews count only the vulnerabilities this upgrade affects. Unrelated vulnerabilities elsewhere in the project are no longer listed as remaining, and the review notes how many there are.

## [0.9.5] - 2026-11-10

### Added

- Right-click a `package.json` in the file tree or on its editor tab and choose **Open in Packageawy** to open the dashboard on that project. This works in VS Code and JetBrains IDEs. Suggested by [@Abdulhakiem](https://github.com/Abdulhakiem).
- The `packageawy.security.publicAdvisoryCheck` setting turns the vulnerability checks, identifier lookups and npm audit on or off for each project. When it is off, the Vulnerabilities column reads Off. JetBrains IDEs have the same option under the project's Security settings.
- When no verification scripts are set, reviews for upgrades, removals, and transitive fixes list the project's `typecheck`, `build`, `test`, and `lint` scripts as checkboxes. Checked scripts run after that change, with the same Rollback choice if one fails. Scripts that watch files or start a server are not listed.
- "Remember for this project" saves the checked scripts as the project's verification scripts. In JetBrains IDEs they appear under Settings, Tools, Packageawy, Project.
- After a kept Smart Cleanup, **Restore dependency files** opens recovery to review the saved `package.json` and lockfile.
- Yarn and Bun projects open with their dependencies shown and a note that changes are available for npm and pnpm projects.
- Registries that ask for sign-in get one note per registry, and their packages read **Sign-in needed**. Upgrades for every other package stay available.
- The VSIX and the JetBrains plugin include `ThirdPartyNotices.txt` with the licenses of bundled packages.
- The upgrade review's version list labels **Security fix**, **Publisher LTS** and **Latest stable** versions.
- A removal started from the Manage dialog shows its progress (Installing, Verifying, Refreshing) and then its result in the dialog: what was removed, the install, dependency files, verification, and whether files were restored.
- When verification scripts are checked in the upgrade review, the Verification row names them, for example "build, test will run".
- With vulnerability checks on, upgrade reviews check the proposed dependency tree, including packages with no current advisories. Coordinated upgrade plans are checked too. The review lists added vulnerabilities with package, version and severity, next to the ones it resolves and the ones that remain. If the check cannot run, it reads **Security check unavailable**.
- When an upgrade would add a high or critical vulnerability, the review asks you to tick an acknowledgement before it can be confirmed.
- Offered update versions with known vulnerabilities are marked in the Available version cell, on the Overview card and in the upgrade version list, for example "2.3.0 has 3 known vulnerabilities. Highest severity: high."

### Changed

- Smart Cleanup focuses on unused packages and vulnerability fixes. The Duplicate versions section is removed.
- Smart Cleanup results say when only the dependency files were checked because no build or test scripts are set, and counts match across the header, signals and sections.
- The upgrade review summary and the Manage dependency tabs are shorter and clearer.
- pnpm is found through PATH, `PNPM_HOME`, the standalone installer, Homebrew, Volta, Scoop, winget, mise and asdf, as well as npm's global folder and Corepack. A version named in `packageManager` is preferred.
- Packages under an `@scope` with its own registry in `.npmrc` are looked up on that registry in every scan and review. Workspace members also read the workspace root `.npmrc`.
- npm audit runs for at most one minute, and the table shows without it when it cannot finish.
- Upgrades keep the declared range style. `^1.2.3` stays `^`, `~1.2.3` stays `~`, and an exact version stays exact. `package.json` keeps its key order, indentation, spacing, line endings and final newline when upgrading and removing.
- The Overview card, the dependency table, single upgrade review and bulk review all start on the same suggested version. Change-type badges and summary counts use one rule, so 0.21.1 to 0.22.0 is minor and 0.21.1 to 1.21.1 is major.
- Opening Smart Cleanup closes the Manage dialog first, so only one dialog is open at a time.
- After an upgrade, the Manage dialog footer says the changes were applied, and after a rollback that the files were restored.
- The **Open setting** link on the "Security checks are turned off" banner opens the settings scope that holds the value: folder, workspace or user.
- The registry cache is stored as files in the extension's storage folder instead of VS Code global state. The existing cache moves over once.
- npm audit runs the same resolved `node` and npm that upgrades use, without a shell.
- The **Safe** badge explains that it covers the installed dependency tree.
- Saved dashboard results from earlier versions are refreshed once after updating, so aliased packages are checked under the right name.

### Fixed

- Aliased packages, such as `compat: npm:lodash@4.17.20` and `string-width-cjs`, are checked for vulnerabilities under their real package name.
- Packages whose installed version is unknown read **Not checked** with a hint to install dependencies.
- npm workspace members show the versions installed for that member.
- pnpm `catalog:` dependencies keep their catalog reference.
- Upgrades, removals and fixes at the root of a pnpm workspace run with `-w`.
- Only one dependency change runs per project, including after the dashboard is closed and opened again.
- Prettier 2 plugins count as used.
- Tab and Shift+Tab stay inside every dialog.
- The Manage dialog no longer reopens on its own after a removal, a project switch, or a rescan where the package was gone and later came back.
- Scans and Refresh on Windows no longer print Node's DEP0190 warning.
- Dashboard vulnerability results and upgrade reviews include installed peer dependencies and their descendants.
- Changing the vulnerability check setting cancels a transitive fix check in progress and asks you to review the fix again. The dashboard refreshes after active work finishes.

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
- Re-reads the project right before every change and stops rollback if it sees dependency files changed.

[0.9.7]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.7
[0.9.6]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.6
[0.9.5]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.5
[0.9.4]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.4
[0.9.3]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.3
[0.9.2]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.2
[0.9.1]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.1
[0.9.0]: https://github.com/Azzam-Aldulaylan/packageawy/releases/tag/v0.9.0
