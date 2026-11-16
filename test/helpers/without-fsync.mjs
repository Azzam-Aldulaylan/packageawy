import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { before, after } from 'node:test';

/** These suites test settlement, bytes and inode ownership. Journal durability has its own suites. */
export function withoutFsync() {
  const open = fs.open;
  before(() => {
    fs.open = async (...args) => {
      const handle = await open(...args);
      handle.sync = async () => {};
      return handle;
    };
    syncBuiltinESMExports();
  });
  after(() => { fs.open = open; syncBuiltinESMExports(); });
}
