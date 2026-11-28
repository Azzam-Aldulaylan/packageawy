import { accessSync, constants, statSync } from 'node:fs';

export function browserSkip(reason) {
  const executable = process.env.PACKAGEAWY_CHROMIUM_PATH;
  if (!executable) {
    if (process.env.PACKAGEAWY_REQUIRE_BROWSER_TESTS === '1') {
      throw new Error('PACKAGEAWY_CHROMIUM_PATH must be set when PACKAGEAWY_REQUIRE_BROWSER_TESTS=1.');
    }
    return reason;
  }
  try {
    if (!statSync(executable).isFile()) throw new Error('The path is not a file.');
    accessSync(executable, constants.X_OK);
  } catch (cause) {
    throw new Error(`PACKAGEAWY_CHROMIUM_PATH must point to an executable file: ${executable}`, { cause });
  }
  return false;
}
