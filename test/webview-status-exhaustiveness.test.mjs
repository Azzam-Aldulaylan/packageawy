import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';

// Add a wire status in memory, including its validation classification, while
// leaving the real App handler unchanged. Only its never arm must reject it.
test('adding a host status without an App handler fails the TypeScript never check', () => {
  const configPath = path.resolve('webview/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile;
  host.readFile = file => {
    let source = readFile(file);
    if (source !== undefined && file.endsWith('/src/host/webviewProtocol.ts')) {
      source = source.replace('export type HostToWebviewMessage =', "export type HostToWebviewMessage =\n  | { status: 'fixture-unhandled' }");
      source = source.replace('export const HOST_MESSAGE_STATUSES = {', "export const HOST_MESSAGE_STATUSES = {\n  'fixture-unhandled': true,");
    }
    return source;
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 1, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  assert.ok(errors[0].file.fileName.endsWith('/webview/src/App.tsx'));
  assert.equal(errors[0].code, 2345);
  assert.match(ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'), /fixture-unhandled.*not assignable.*never/);
});
