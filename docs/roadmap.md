# Roadmap

Planned work, roughly in priority order. Nothing here is promised for a specific release.

## Next

- **Fewer false "likely unused" results.** Treat packages required as peers by other direct dependencies, and `@types/*` packages, as used. Consider building on [knip](https://knip.dev). Until then, the signal stays a prompt to look, not a recommendation.
- **Simpler review screens.** Show each check once, give one clear recommendation, and keep routine minor and patch updates calm.
- **A private-project option.** Let users keep private package names out of the public npm advisory check and GitHub lookups.
- **Troubleshooting report.** A user-triggered, redacted summary of timings, failure codes, and versions that can be copied into a bug report. No background telemetry.

## Later

- Older pnpm lockfile formats, pnpm catalogs and aliases, and pnpm audit data.
- Checking workspace member manifests and `pnpm-workspace.yaml` settings during compatibility analysis.
- Caching compatibility results per project between sessions.
- A history view for past analyses and changes.
- Yarn support, if there is demand.

## Code health

- Split the largest files (`src/host/upgradeAssistantCoordinator.ts`, `webview/src/App.tsx`, `src/host/webviewProtocol.ts`, `src/host/dashboardPanel.ts`) along their existing boundaries.
- Replace tests that match source text with tests that render components and check behavior.
- Run the packaged extension on Windows, macOS, and Linux before each release and publish the tested support matrix.

## Out of scope

- Ecosystems other than npm and pnpm.
- Container images, OS packages, and globally installed tools.
