/**
 * Method names and parameter shapes for the sidecar protocol described in
 * ../hostPlatform.ts. Ids for watches, progress and processes are integers
 * chosen by the sidecar. Optional fields are omitted, never null, unless the
 * type says null.
 */

import type { WorkspaceFolder } from '../hostPlatform.js';

export type StorageSnapshot = Record<string, unknown>;

// Client to sidecar.

export interface InitializeParams {
  workspaceFolders: WorkspaceFolder[];
  isWorkspaceTrusted: boolean;
  /** Keys relative to the `packageawy` section, as in HostPlatform.getSetting. */
  settings: Record<string, unknown>;
  workspaceState: StorageSnapshot;
  globalState: StorageSnapshot;
  /** Shown in the dashboard footer. */
  clientVersion?: string;
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
}

export interface DidChangeFoldersParams {
  workspaceFolders: WorkspaceFolder[];
}

export interface DidChangeTrustParams {
  isWorkspaceTrusted: boolean;
}

/** The full current settings, replacing the previous copy. */
export interface DidChangeSettingsParams {
  settings: Record<string, unknown>;
}

export interface FileDidChangeParams {
  watchId: number;
  path: string;
}

export interface GitDidChangeHeadParams {
  watchId: number;
}

export interface ProgressCancelParams {
  progressId: number;
}

export interface ProcessDidExitParams {
  processId: number;
  exitCode: number | null;
}

export interface WebviewMessageParams {
  message: unknown;
}

// Sidecar to client.

/** A missing `value` removes the key. The client also treats null as removal. */
export interface StorageUpdateParams {
  scope: 'workspace' | 'global';
  key: string;
  value?: unknown;
}

/**
 * `include` is relative to `folder.path` joined with `dir`. `exclude` is
 * matched against folder-relative paths. Returns absolute paths.
 */
export interface FilesFindParams {
  folder: WorkspaceFolder;
  dir: string;
  include: string;
  exclude: string;
  maxResults?: number;
}

export interface FilesWatchParams {
  watchId: number;
  baseDir: string;
  glob: string;
}

export interface WatchIdParams {
  watchId: number;
}

export interface GitWatchHeadParams {
  watchId: number;
  projectPath: string;
}

export interface ProgressStartParams {
  progressId: number;
  title: string;
  cancellable: boolean;
}

export interface ProgressReportParams {
  progressId: number;
  message?: string;
  increment?: number;
}

export interface ProgressEndParams {
  progressId: number;
}

export interface ShowMessageParams {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ShowModalParams {
  message: string;
  detail: string;
  actions: string[];
}

export interface ShowQuickPickParams {
  items: { label: string; description?: string; detail?: string }[];
  options: {
    title: string;
    placeholder: string;
    matchOnDescription: boolean;
    matchOnDetail: boolean;
  };
}

export interface ProcessStartParams {
  processId: number;
  executable: string;
  args: string[];
  cwd: string;
  title: string;
  scope: string;
}

/** One-based line and column. */
export interface OpenFileParams {
  path: string;
  position?: { line: number; column: number };
}

export interface OpenExternalParams {
  url: string;
}

export interface OpenSettingsParams {
  key: string;
}

export const Methods = {
  initialize: 'initialize',
  didChangeFolders: 'workspace/didChangeFolders',
  didChangeTrust: 'workspace/didChangeTrust',
  didChangeSettings: 'settings/didChange',
  storageUpdate: 'storage/update',
  filesFind: 'files/find',
  filesWatch: 'files/watch',
  filesDidChange: 'files/didChange',
  filesUnwatch: 'files/unwatch',
  gitWatchHead: 'git/watchHead',
  gitDidChangeHead: 'git/didChangeHead',
  gitUnwatchHead: 'git/unwatchHead',
  progressStart: 'progress/start',
  progressReport: 'progress/report',
  progressEnd: 'progress/end',
  progressCancel: 'progress/cancel',
  showMessage: 'window/showMessage',
  showModal: 'window/showModal',
  showQuickPick: 'window/showQuickPick',
  processStart: 'process/start',
  processDidExit: 'process/didExit',
  openFile: 'window/openFile',
  openExternal: 'window/openExternal',
  openSettings: 'window/openSettings',
  webviewPostMessage: 'webview/postMessage',
  webviewDidReceiveMessage: 'webview/didReceiveMessage',
  webviewDidDispose: 'webview/didDispose',
  webviewReveal: 'webview/reveal',
  cancelRequest: '$/cancelRequest',
} as const;
