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
   - **dry_run**: run release verification, VSIX packaging and VSIX smoke tests without publishing or creating a tag or release.
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

JetBrains documents how to create the certificate chain and private key in its plugin signing guide. The four JetBrains secrets are only needed when **publish_jetbrains** is on. Marketplace and Open VSX secrets are checked before the VSIX publish steps. JetBrains secrets are checked at the start of the JetBrains job, after the GitHub release is created. Each check names missing secrets and stops its job.

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
- [ ] Record that the dashboard draws its dependency rows on first open and after closing and reopening it.

Note the VS Code version, operating system, package manager, and VSIX SHA-256 in the release notes.

## Dependency recovery, each release candidate

Use throwaway projects. Run each check in VS Code and a JetBrains IDE on both macOS and Windows, and record the host, OS and package manager.

- [ ] Kill the editor during an install, reopen the project and check that dependency changes stay blocked and no file restores by itself.
- [ ] VS Code: start a slow upgrade install from Packageawy and wait until its task is running in the terminal. Run **Developer: Restart Extension Host** from the Command Palette. Check that the install keeps running in the same terminal. Reopen Packageawy and check that the unknown outcome keeps dependency changes blocked, shows "An earlier change may still be running. Dependency changes are blocked." and offers **Start recovery**. Check that `.packageawy-recovery` and its lock remain. Stop the install in its task terminal and wait for it to exit before confirming that all writers stopped in recovery.
- [ ] JetBrains: start a slow upgrade install from Packageawy and wait until its task is running in the Run tool window. Find the Node sidecar by its full command, which names the Packageawy plugin's `sidecar/sidecar.js`. On macOS, use `ps -axo pid,ppid,command | grep '[/]sidecar/sidecar[.]js'`. On Windows, use PowerShell `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '[\\/]sidecar[\\/]sidecar\.js' } | Select-Object ProcessId,ParentProcessId,CommandLine`. Match its parent PID to the IDE process. End only that sidecar PID with `kill -KILL <pid>` on macOS or `Stop-Process -Id <pid> -Force` in PowerShell on Windows. Check that the install keeps running in the Run tool window and that "The Packageawy engine stopped." appears. Choose **Restart** on that notification. Check that the unknown outcome keeps dependency changes blocked, shows "An earlier change may still be running. Dependency changes are blocked." and offers **Start recovery**. Check that `.packageawy-recovery` and its lock remain. Stop the install in its Run tab and wait for it to exit before confirming that all writers stopped in recovery.
- [ ] In JetBrains, try Restart while a dependency change is running. Check for "Cannot restart while a dependency change is running or its outcome is unknown." and that the install continues.
- [ ] In JetBrains, try Restart when idle. Check that the dashboard reloads and dependency rows appear.
- [ ] Run a slow install. Check that "Still running" appears after about 10 seconds and clears when the task ends.
- [ ] Open the same project in two windows, including one window in each host. Only one dependency change can acquire the recovery folder.
- [ ] Start recovery after confirming all writers stopped. Check the running-install race warning, default Keep current choices, backup/current contents and explicit deletion approval.
- [ ] Edit a dependency file after reviewing recovery choices. Applying the old choices must stop and keep saved files. Retry from the current contents.
- [ ] In an empty throwaway folder, run `npm init -y` and `npm install --ignore-scripts --save-exact is-number@6.0.0`. Replace the generated `test` entry under `scripts` in `package.json` with `"test": "node -e \"process.exit(1)\""`. In VS Code, set `"packageawy.upgrade.verificationScripts": ["test"]` in workspace settings. In JetBrains, open **Settings**, **Tools**, **Packageawy**, **Project**, select **Use project-specific verification scripts** and enter `test` in **Scripts:**. Open the project in Packageawy, select `is-number` version `7.0.0`, choose **Analyze upgrade** and apply the reviewed upgrade. Wait for the test task to fail and the "The dependency installed, but post-upgrade verification failed." prompt to appear. Leave it open. From another editor or terminal, change `is-number` in `package.json` to `"6.0.0"` and save. Choose **Rollback** in the waiting prompt. Check that restore stops, names `package.json` and keeps the saved edit.
- [ ] Restore dependency files with a lockfile and choose **Reinstall** in the frozen reinstall offer. Check that `npm ci --ignore-scripts` or `pnpm install --frozen-lockfile --ignore-scripts` runs as a visible task.
- [ ] Repeat the restore and decline the reinstall offer. Check for the note about `node_modules` and how to reinstall by hand.
- [ ] Interrupt recovery after a displacement. Reopen, check the recorded progress and confirm that nothing resumes automatically and the displaced contents remain saved.
- [ ] Close recovery without dismissal. Saved files and the lock remain. Remove saved files and unlock only after reviewing the result.
- [ ] Interrupt dismissal, reopen in a fresh editor process and finish the remaining cleanup after the stop confirmation.
- [ ] Leave a `takeover` folder behind. Packageawy must refuse to remove it and explain how to remove it by hand after closing other windows.
