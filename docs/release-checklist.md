# Release checklist

Run these from the repository root with Node.js 22 or newer.

## Build and test

```bash
npm ci
npm run test:release
npm run package -- --out packageawy-<version>.vsix
```

For a pre-release, add `--pre-release` to the package command. Use an odd minor version for pre-releases (for example `0.9.0`) and an even one for stable releases, as the Marketplace recommends.

- [ ] CI passes on Ubuntu and Windows for both the current and the minimum supported VS Code version, and the packaged VSIX smoke test passes on Ubuntu, Windows and macOS.
- [ ] `npx vsce ls` lists only the runtime bundles, `package.json`, README, changelog, license, `ThirdPartyNotices.txt`, and the icons.
- [ ] The VSIX installs into a clean VS Code profile and the dashboard opens against a throwaway npm project.

## Listing

- [ ] `version` in `package.json` matches the changelog, and the changelog entry has a date.
- [ ] README screenshots, settings, privacy notes, and requirements match the release.
- [ ] The Marketplace preview shows the right name, icon, categories, and links.

## Publish

Releases are published by the **Release** workflow. It runs only when started by hand and only from the default branch.

1. Open the repository's **Actions** tab and choose **Release**.
2. Choose **Run workflow** and keep the default branch selected.
3. Choose the inputs:
   - **pre_release**: on for a pre-release. The workflow warns when the minor version does not follow the odd and even rule above.
   - **publish_marketplace**: publish to the Visual Studio Marketplace.
   - **publish_open_vsx**: publish to Open VSX.
   - **publish_jetbrains**: publish the JetBrains plugin to JetBrains Marketplace.
   - **dry_run**: run every check, build and smoke test, but publish nothing and create no tag or release.
4. Choose **Run workflow** again to start it.

The workflow then does the following:

- Checks that `package.json` has a version with a dated changelog section, that the tag `v<version>` does not exist yet, and that neither store already has the version. It also runs the typecheck and the tests.
- Packages the VSIX once, checks its contents, and records its SHA-256.
- Installs that VSIX into a clean VS Code on Linux, Windows and macOS and opens the dashboard.
- Publishes the same VSIX to each chosen store, creates the tag `v<version>` on the commit the run started from, and creates the GitHub release with the changelog section as notes and the VSIX and its `.sha256` file attached.
- When **publish_jetbrains** is on, builds the plugin with the production bundles and the real sidecar, signs it, publishes it, and attaches the signed plugin zip to the same GitHub release.

The release checks can also be run locally before starting the workflow:

```bash
node scripts/release/release-checks.mjs verify --pre-release true
```

- [ ] Install from the Marketplace on a clean profile and confirm the version, commands, and one refresh.

### One-time setup

1. In the repository settings, open **Environments** and create an environment named `release`. To approve each release before anything is published, add yourself as a required reviewer.
2. Add these secrets to the `release` environment:

| Secret | Used for | Where it comes from |
| --- | --- | --- |
| `VSCE_PAT` | Visual Studio Marketplace | An Azure DevOps personal access token for the organization that owns the `Azzam` publisher. Set Organization to **All accessible organizations** and give it the **Marketplace: Manage** scope. |
| `OVSX_PAT` | Open VSX | An access token created on open-vsx.org under **Settings**, **Access Tokens**, signed in as the owner of the `Azzam` namespace. |
| `JETBRAINS_PUBLISH_TOKEN` | JetBrains Marketplace | A permanent token from the JetBrains Marketplace profile page under **My Tokens**. |
| `JETBRAINS_CERTIFICATE_CHAIN` | Plugin signing | The full text of the signing certificate chain, `chain.crt`. |
| `JETBRAINS_PRIVATE_KEY` | Plugin signing | The full text of the private key, `private.pem`. |
| `JETBRAINS_PRIVATE_KEY_PASSWORD` | Plugin signing | The password for that private key. |

JetBrains documents how to create the certificate chain and private key in its plugin signing guide. The four JetBrains secrets are only needed when **publish_jetbrains** is on. When a store is chosen but its secret is missing, the workflow stops before publishing anything and names the missing secret.

### Manual fallback

The same steps can be done by hand from the repository root:

- [ ] Tag the release commit `v<version>`.
- [ ] Create GitHub release notes from the changelog and attach the tested VSIX.
- [ ] Publish the same VSIX to the Marketplace with `npx @vscode/vsce publish --packagePath packageawy-<version>.vsix`. Add `--pre-release` for a pre-release.
- [ ] Publish the same VSIX to Open VSX with `npx ovsx publish packageawy-<version>.vsix -p <token>`. Add `--pre-release` for a pre-release. The token comes from open-vsx.org and stays off the repo.

## Manual smoke test

- [ ] macOS: npm project, refresh, and one review.
- [ ] Windows: npm project, refresh, and one review.
- [ ] Linux: npm or pnpm project, refresh, and one review.

Note the VS Code version, operating system, package manager, and VSIX SHA-256 in the release notes.
