/**
 * Stop a child process together with everything it started.
 *
 * Core code cannot import from src/host, so this mirrors the tree termination
 * in host/packageManagerProcessRunner.ts for core-owned subprocesses.
 *
 * POSIX: the child must have been spawned with `detached: true`, which gives
 * it its own process group. Signalling the negative pid then reaches npm and
 * anything npm started, without touching the extension host's own group.
 *
 * Windows: there are no POSIX process groups, and a `shell: true` spawn makes
 * the child cmd.exe rather than npm. Killing only cmd.exe leaves npm running,
 * so `taskkill /T` walks and ends the whole tree. The returned promise settles
 * once taskkill has finished (or given up), never rejecting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const TASKKILL_DEADLINE_MS = 2_000;

export function terminateProcessTree(
  child: ChildProcess,
  killSignal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();

  if (platform !== 'win32') {
    try {
      process.kill(-pid, killSignal);
    } catch (cause) {
      // ESRCH means the group is already gone. Anything else (for example the
      // child was not detached) falls back to signalling the child alone.
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(killSignal);
    }
    return Promise.resolve();
  }

  return new Promise<void>((done) => {
    const taskkill = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    const deadline = setTimeout(() => {
      killer.kill('SIGKILL');
      child.kill('SIGKILL');
      done();
    }, TASKKILL_DEADLINE_MS);
    deadline.unref();
    killer.once('error', () => {
      clearTimeout(deadline);
      child.kill('SIGKILL');
      done();
    });
    killer.once('close', (code) => {
      clearTimeout(deadline);
      if (code !== 0) child.kill('SIGKILL');
      done();
    });
  });
}
