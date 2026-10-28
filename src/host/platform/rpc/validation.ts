/** Checks parameters the client sends. Each parser throws an InvalidParams error on a bad shape. */

import type { WorkspaceFolder } from '../hostPlatform.js';
import { ErrorCodes, ResponseError } from './jsonRpc.js';
import type {
  DidChangeFoldersParams,
  DidChangeSettingsParams,
  DidChangeTrustParams,
  FileDidChangeParams,
  InitializeParams,
  ProcessDidExitParams,
  WebviewMessageParams,
} from './protocol.js';

function invalid(message: string): ResponseError {
  return new ResponseError(ErrorCodes.InvalidParams, message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') throw invalid(`${what} must be a string`);
  return value;
}

function boolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${what} must be a boolean`);
  return value;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${what} must be an integer`);
  return value;
}

function folders(value: unknown): WorkspaceFolder[] {
  if (!Array.isArray(value)) throw invalid('workspaceFolders must be an array');
  return value.map((item, index) => {
    const folder = record(item, `workspaceFolders[${index}]`);
    return {
      id: string(folder['id'], 'folder id'),
      name: string(folder['name'], 'folder name'),
      path: string(folder['path'], 'folder path'),
    };
  });
}

export function parseInitialize(params: unknown): InitializeParams {
  const value = record(params, 'initialize params');
  const clientVersion = value['clientVersion'];
  return {
    workspaceFolders: folders(value['workspaceFolders']),
    isWorkspaceTrusted: boolean(value['isWorkspaceTrusted'], 'isWorkspaceTrusted'),
    settings: value['settings'] === undefined ? {} : record(value['settings'], 'settings'),
    workspaceState: value['workspaceState'] === undefined ? {} : record(value['workspaceState'], 'workspaceState'),
    globalState: value['globalState'] === undefined ? {} : record(value['globalState'], 'globalState'),
    ...(clientVersion === undefined ? {} : { clientVersion: string(clientVersion, 'clientVersion') }),
  };
}

export function parseDidChangeFolders(params: unknown): DidChangeFoldersParams {
  return { workspaceFolders: folders(record(params, 'params')['workspaceFolders']) };
}

export function parseDidChangeTrust(params: unknown): DidChangeTrustParams {
  return { isWorkspaceTrusted: boolean(record(params, 'params')['isWorkspaceTrusted'], 'isWorkspaceTrusted') };
}

export function parseDidChangeSettings(params: unknown): DidChangeSettingsParams {
  return { settings: record(record(params, 'params')['settings'], 'settings') };
}

export function parseFileDidChange(params: unknown): FileDidChangeParams {
  const value = record(params, 'params');
  return { watchId: integer(value['watchId'], 'watchId'), path: string(value['path'], 'path') };
}

export function parseIdParam(params: unknown, name: string): number {
  return integer(record(params, 'params')[name], name);
}

export function parseProcessDidExit(params: unknown): ProcessDidExitParams {
  const value = record(params, 'params');
  const exitCode = value['exitCode'];
  return {
    processId: integer(value['processId'], 'processId'),
    exitCode: exitCode === null || exitCode === undefined ? null : integer(exitCode, 'exitCode'),
  };
}

export function parseWebviewMessage(params: unknown): WebviewMessageParams {
  const value = record(params, 'params');
  if (!('message' in value)) throw invalid('message is required');
  return { message: value['message'] };
}
