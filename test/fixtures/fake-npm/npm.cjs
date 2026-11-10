// Stand-in for npm in the audit runner tests. The first argument picks the
// behavior. The real audit arguments follow and are ignored.
'use strict';
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const [mode, pidFile] = process.argv.slice(2);
const REPORT = JSON.stringify({ vulnerabilities: {} });

switch (mode) {
  case 'hang': {
    // A grandchild proves the whole tree is stopped, not just this process.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
    break;
  }
  case 'stderr-flood': {
    // Far past any pipe buffer. If nobody drains stderr this write never ends.
    process.stderr.write('npm warn '.repeat(1_000_000), () => {
      process.stdout.write(REPORT, () => process.exit(1));
    });
    break;
  }
  case 'stdout-flood': {
    process.stdout.write('x'.repeat(1_000_000), () => process.exit(0));
    break;
  }
  case 'fail': {
    process.stderr.write('npm error code ENOLOCK\n', () => process.exit(2));
    break;
  }
  default:
    process.exit(3);
}
