# Testing in VS Code

How to run Packageawy against a real npm or pnpm project while developing it.

## Requirements

- VS Code 1.90 or newer
- Node.js 22 or newer
- A trusted project with a `package.json`, ideally with a lockfile (`package-lock.json`, `npm-shrinkwrap.json`, or `pnpm-lock.yaml`)

The development build can read the project's `.npmrc`, query registries, and run your package manager after you confirm a change. Use a throwaway project or branch when testing changes.

## Setup

Open this repository (not the project you want to inspect) in VS Code and install dependencies:

```bash
npm ci
npm run typecheck
npm test
```

`npm ci` also installs the pinned pnpm used by the pnpm test fixtures, so you don't need pnpm installed globally.

Create `.vscode/launch.json` in this repository. The folder is ignored by Git.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Packageawy against a project",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}", "${input:targetProjectPath}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ],
  "inputs": [
    {
      "id": "targetProjectPath",
      "type": "promptString",
      "description": "Absolute path to the npm or pnpm project to inspect",
      "default": "/absolute/path/to/your/project"
    }
  ]
}
```

## Running it

1. Open **Run and Debug**, pick **Run Packageawy against a project**, and press `F5`.
2. Enter the absolute path to the project. Paths with spaces are fine.
3. In the new **Extension Development Host** window, trust the workspace if asked.
4. Run **Packageawy: Open** from the Command Palette.

The extension is rebuilt on every launch. After changing code, stop the session and press `F5` again.

## Automated tests

`npm test` is the fast offline suite. Two slower suites use real package managers and the public registry, so they need network access. Both create throwaway projects in your temp folder and never touch your own projects.

```bash
npm run test:real-projects    # upgrade, removal, rollback, and concurrent-edit checks for npm and pnpm
npm run test:extension-host   # downloads VS Code and runs the extension against those projects
```

Useful variations:

```bash
npm run test:extension-host -- --manager=npm
npm run test:extension-host -- --manager=pnpm
VSCODE_TEST_VERSION=1.90.0 npm run test:extension-host
PACKAGEAWY_HOST_SOAK_MS=600000 npm run test:extension-host
```

The soak setting keeps the dashboard open longer to catch results disappearing over time. Set `PACKAGEAWY_KEEP_FIXTURES=1` to keep the generated projects for inspection.

## Debugging

- Extension logs and errors show up in the **Debug Console** of the window you launched from.
- For webview logs, run **Developer: Open Webview Developer Tools** in the Extension Development Host.
- Turn on `packageawy.debug.performance` in the target project's settings to log timings.

## Common problems

- **The command is missing.** Make sure the project has a `package.json`, the workspace is trusted, and the window title says **Extension Development Host**.
- **The wrong project shows up.** Use the project picker in the dashboard, or launch with a narrower folder.
- **Results look stale.** Run **Packageawy: Refresh**. After code changes, restart the debug session.
- **The build can't find Node.** Start VS Code from a terminal where `node` and `npm` work.
- **A test changed your project.** Check `git diff` in that project and restore the files from its own version control.
