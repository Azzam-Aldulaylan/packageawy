// Safety helpers for startup-timing.mjs, kept apart so the unit tests can
// load them without starting VS Code.
import { spawn } from 'node:child_process';
import path from 'node:path';

// Environment variables that steer VS Code to a profile, an extensions
// folder, or an already running instance, ahead of --user-data-dir and
// --extensions-dir. VSCODE_PORTABLE and VSCODE_APPDATA pick the user data
// folder, VSCODE_EXTENSIONS the extensions folder, VSCODE_IPC_HOOK_CLI (set
// in VS Code's integrated terminal) hands CLI commands to the running
// window, and the ELECTRON_ variables change how the binary starts. Every
// VSCODE_ and ELECTRON_ variable is removed, so a variable added in a future
// VS Code release is covered too.
const BLOCKED_PREFIXES = ['VSCODE_', 'ELECTRON_'];

/** A copy of `env` without the variables above, plus `extra`. */
export function sanitizedEnvironment(env, extra = {}) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    if (value !== undefined) clean[name] = value;
  }
  // Electron rejects several Node-only flags inherited from developer shells.
  clean.NODE_OPTIONS = '';
  return { ...clean, ...extra };
}

/** True when `child` is strictly inside `parent`. */
export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Throws unless every folder is inside `root`. */
export function assertInsideTempRoot(root, folders) {
  for (const [label, folder] of Object.entries(folders)) {
    if (!isInside(folder, root)) {
      throw new Error(`Refusing to start VS Code: the ${label} ${folder} is not inside the temporary folder ${root}.`);
    }
  }
}

/**
 * Ends a child started with `detached: true` and everything it started, and
 * resolves once the child has exited. POSIX: SIGTERM to the process group,
 * then SIGKILL after `graceMs`. Windows: taskkill /T /F on the tree.
 */
export function killProcessTree(child, { graceMs = 5000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    const signalTree = (signal) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Already gone.
      }
    };
    signalTree('SIGTERM');
    timer = setTimeout(() => signalTree('SIGKILL'), graceMs);
  });
}

/**
 * Runs `attempt` until it returns { ok: true }, at most 1 + `retries` times.
 * Returns { ok, attempts, errors }.
 */
export async function withRetries(attempt, retries) {
  const errors = [];
  for (let index = 0; index <= retries; index += 1) {
    const outcome = await attempt(index + 1);
    if (outcome.ok) return { ok: true, attempts: index + 1, errors };
    errors.push(outcome.error ?? 'unknown error');
  }
  return { ok: false, attempts: retries + 1, errors };
}
