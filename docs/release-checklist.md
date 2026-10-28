# Release checklist

Run these from the repository root with Node.js 22 or newer.

## Build and test

```bash
npm ci
npm run test:release
npm run package -- --out packageawy-<version>.vsix
```

For a pre-release, add `--pre-release` to the package command. Use an odd minor version for pre-releases (for example `0.9.0`) and an even one for stable releases, as the Marketplace recommends.

- [ ] CI passes on Ubuntu and Windows for both the current and the minimum supported VS Code version.
- [ ] `npx vsce ls` lists only the runtime bundles, `package.json`, README, changelog, license, and icon.
- [ ] The VSIX installs into a clean VS Code profile and the dashboard opens against a throwaway npm project.

## Listing

- [ ] `version` in `package.json` matches the changelog, and the changelog entry has a date.
- [ ] README screenshots, settings, privacy notes, and requirements match the release.
- [ ] The Marketplace preview shows the right name, icon, categories, and links.

## Publish

- [ ] Tag the release commit `v<version>`.
- [ ] Create GitHub release notes from the changelog and attach the tested VSIX.
- [ ] Publish the same VSIX to the Marketplace with `npx @vscode/vsce publish --packagePath packageawy-<version>.vsix`. Add `--pre-release` for a pre-release.
- [ ] Publish the same VSIX to Open VSX with `npx ovsx publish packageawy-<version>.vsix -p <token>`. Add `--pre-release` for a pre-release. The token comes from open-vsx.org and stays off the repo.
- [ ] Install from the Marketplace on a clean profile and confirm the version, commands, and one refresh.

## Manual smoke test

- [ ] macOS: npm project, refresh, and one review.
- [ ] Windows: npm project, refresh, and one review.
- [ ] Linux: npm or pnpm project, refresh, and one review.

Note the VS Code version, operating system, package manager, and VSIX SHA-256 in the release notes.
