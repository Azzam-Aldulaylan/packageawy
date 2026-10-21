/**
 * Recognized JS/TS tooling config files, and the plain word-boundary text
 * check used against their content: a package named as an ESLint/Babel/
 * PostCSS/Tailwind/webpack/Vite/Next.js plugin, or referenced from
 * `tsconfig.json`'s `extends`, is real usage the import scanner can never
 * see (none of these are JS import statements).
 *
 * The glob list is host-owned (src/host/usage/configFiles.ts uses it to
 * enumerate candidate files). This module only owns the content check,
 * which is pure and independently testable.
 */

export const CONFIG_FILE_GLOBS: readonly string[] = [
  '.eslintrc',
  '.eslintrc.*',
  'eslint.config.*',
  'babel.config.*',
  '.babelrc',
  '.babelrc.*',
  'postcss.config.*',
  'tailwind.config.*',
  'webpack.config.*',
  'vite.config.*',
  'next.config.*',
  'metro.config.*',
  'react-native.config.*',
  'jest.config.*',
  'vitest.config.*',
  'rollup.config.*',
  'tsconfig.json',
  'tsconfig.*.json',
];

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateTokens(packageName: string): string[] {
  if (!packageName.startsWith('@')) return [packageName];
  const slash = packageName.indexOf('/');
  return slash === -1 ? [packageName] : [packageName, packageName.slice(slash + 1)];
}

const QUOTED_SEGMENT = '[^"\'\\x60\\s/]+';

function isEslintConfigFile(fileName: string): boolean {
  return /^\.eslintrc(\.|$)/.test(fileName) || /^eslint\.config\./.test(fileName);
}

/**
 * The short names ESLint resolves to this package inside `extends` and
 * `plugins`. `eslint-config-next` is written `next` or
 * `next/core-web-vitals`, `eslint-plugin-react` is written `react` or
 * `plugin:react/recommended`, and `@scope/eslint-plugin-foo` is written
 * `@scope/foo` or `plugin:@scope/foo/recommended`.
 */
function eslintShorthandPatterns(packageName: string): string[] {
  const match = /^(?:(@[^/]+)\/)?eslint-(config|plugin)(?:-(.+))?$/.exec(packageName);
  if (match === null) return [];
  const [, scope, kind, rest] = match;
  const name = scope === undefined ? rest : rest === undefined ? scope : `${scope}/${rest}`;
  if (name === undefined) return [];

  const shortName = escapeForRegex(name);
  if (kind === 'plugin') return [shortName, `plugin:${shortName}/${QUOTED_SEGMENT}`];
  // `@scope/foo` names `@scope/eslint-config-foo`, so a bare scope takes no subpath.
  return rest === undefined ? [shortName] : [shortName, `${shortName}/${QUOTED_SEGMENT}`];
}

/**
 * True when `content` references `packageName`. Any config file counts a
 * whole-word mention of the package name, as in a quoted plugin, preset, or
 * extends entry. ESLint config files also count the shorthand names ESLint
 * resolves to the package, but only as a whole quoted value, never an
 * object key.
 */
export function configReferencesPackage(content: string, packageName: string, fileName?: string): boolean {
  const tokens = candidateTokens(packageName);
  const pattern = new RegExp(`(?:^|[^\\w@./-])(${tokens.map(escapeForRegex).join('|')})(?:[^\\w./-]|$)`);
  if (pattern.test(content)) return true;

  if (fileName === undefined || !isEslintConfigFile(fileName)) return false;
  const shorthand = eslintShorthandPatterns(packageName);
  if (shorthand.length === 0) return false;
  return new RegExp(`(["'\\x60])(?:${shorthand.join('|')})\\1(?!\\s*:)`).test(content);
}
