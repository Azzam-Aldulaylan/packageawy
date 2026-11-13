import tseslint from 'typescript-eslint';

// Only the typed promise and unused-variable rules are enabled. They catch
// rejected promises that nothing observes, which is how an error inside a
// webview message handler used to disappear without a trace.
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'webview/dist/**', '.vscode-test/**'],
  },
  {
    files: ['src/**/*.ts', 'webview/src/**/*.ts', 'webview/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        // Matches TypeScript's noUnusedLocals: dropping a key with a rest pattern is fine.
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-floating-promises': ['error', {
        ignoreVoid: false,
        ignoreIIFE: false,
        checkThenables: true,
      }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
