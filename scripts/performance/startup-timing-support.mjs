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

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but belongs to someone else, which does
    // not happen for a group this script created; treat it as alive.
    return error?.code === 'EPERM';
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Ends a child started with `detached: true` and every process in its tree,
 * and resolves with { ok, error? } once they are gone.
 *
 * POSIX: SIGTERM to the process group, then poll the group (not just the
 * child, whose exit says nothing about grandchildren that ignore SIGTERM)
 * and send SIGKILL to the group after `graceMs`. Gives up after a further
 * `killWaitMs` and reports it.
 * Windows: waits for taskkill /T /F and checks its exit code (128 means the
 * process was already gone).
 */
export async function killProcessTree(child, { graceMs = 5000, killWaitMs = 5000, pollMs = 50 } = {}) {
  if (child.pid === undefined) return { ok: true };
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return { ok: true };
    const code = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve(-1));
      killer.once('exit', (exitCode) => resolve(exitCode ?? -1));
    });
    if (code !== 0 && code !== 128) return { ok: false, error: `taskkill exited with ${code}` };
    await waitForExit(child);
    return { ok: true };
  }

  const pgid = child.pid;
  if (!groupAlive(pgid)) return { ok: true };
  signalGroup(pgid, 'SIGTERM');
  const killAt = Date.now() + graceMs;
  const giveUpAt = killAt + killWaitMs;
  let killed = false;
  while (groupAlive(pgid)) {
    if (!killed && Date.now() >= killAt) {
      signalGroup(pgid, 'SIGKILL');
      killed = true;
    }
    if (Date.now() >= giveUpAt) return { ok: false, error: `process group ${pgid} is still running after SIGKILL` };
    await sleep(pollMs);
  }
  await waitForExit(child);
  return { ok: true };
}

/**
 * Runs `attempt` until it returns { ok: true }, at most 1 + `retries` times.
 * `shouldStop` is checked before every attempt, so an interrupt during one
 * attempt does not start another. Returns { ok, attempts, errors, stopped }.
 */
export async function withRetries(attempt, retries, { shouldStop = () => false } = {}) {
  const errors = [];
  let attempts = 0;
  for (let index = 0; index <= retries; index += 1) {
    if (shouldStop()) return { ok: false, attempts, errors, stopped: true };
    attempts += 1;
    const outcome = await attempt(attempts);
    if (outcome.ok) return { ok: true, attempts, errors, stopped: false };
    errors.push(outcome.error ?? 'unknown error');
  }
  return { ok: false, attempts, errors, stopped: false };
}
