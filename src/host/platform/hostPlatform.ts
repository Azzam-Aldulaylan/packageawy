/**
 * Everything src/host needs from the editor it runs in. VsCodePlatform
 * implements it on the VS Code API. Nothing here may import `vscode`.
 *
 * Files are identified by absolute file-system paths. Folder-relative paths
 * are POSIX-separated. Settings keys are relative to the `packageawy`
 * section, for example `upgrade.ignoreScripts`.
 *
 * Remote protocol. A JSON-RPC 2.0 implementation over stdio maps each member
 * as follows. "Request" expects a response. "Notification" does not.
 *
 * The synchronous members read state the client sends up front:
 * - `initialize` request from the client carries the workspace folders, the
 *   trust flag, the current settings, and both storage snapshots.
 * - `workspace/didChangeFolders`, `workspace/didChangeTrust` and
 *   `settings/didChange` notifications keep that state current.
 * - `workspaceFolders`, `isWorkspaceTrusted`, `getSetting` and
 *   `workspaceState.get` / `globalState.get` answer from that copy.
 * - `workspaceState.update` / `globalState.update` update the copy and send
 *   a `storage/update` request with the scope, key and value.
 *
 * The asynchronous members map one to one:
 * - `findFiles` is a `files/find` request. It returns absolute paths.
 *   Cancelling the token sends `$/cancelRequest`.
 * - `statFile` and `readFile` are `files/stat` and `files/read` requests.
 *   The sidecar runs on the same machine, so it may use node:fs instead.
 * - `watchFiles` is a `files/watch` request with a watch id. The client sends
 *   `files/didChange` notifications with that id and the path. Disposing
 *   sends a `files/unwatch` notification.
 * - `watchGitHead` is a `git/watchHead` request with a watch id. The client
 *   answers false when the project is not in a repository it can observe,
 *   then sends `git/didChangeHead` notifications. Disposing sends
 *   `git/unwatchHead`.
 * - `withProgress` sends `progress/start`, `progress/report` and
 *   `progress/end` notifications with a progress id. The client sends
 *   `progress/cancel` when the user cancels.
 * - `showInformationMessage`, `showWarningMessage` and `showErrorMessage`
 *   are a `window/showMessage` notification with a severity.
 * - `showModalWarning` is a `window/showModal` request. It returns the chosen
 *   action or null.
 * - `showQuickPick` is a `window/showQuickPick` request with the items'
 *   labels. It returns the chosen index or null. The values stay in the
 *   sidecar. Cancelling the token sends `$/cancelRequest`.
 * - `runProcess` is a `process/start` request with a process id. The client
 *   runs the process in its own console so the user sees live output. The
 *   request fails if the process cannot start. The client then sends a
 *   `process/didExit` notification with the exit code, or null when none
 *   was observed.
 * - `openFile`, `openExternal` and `openSettings` are `window/openFile`,
 *   `window/openExternal` and `window/openSettings` notifications.
 *
 * The webview channel is separate from the platform:
 * - `postMessage` is a `webview/postMessage` notification to the client.
 * - The client forwards each message from the webview as a
 *   `webview/didReceiveMessage` notification and sends `webview/didDispose`
 *   when the view closes. `reveal` is a `webview/reveal` notification.
 *
 * Parameter shapes are in rpc/protocol.ts. The sidecar entry point is
 * src/sidecar/main.ts.
 */

import type { KeyValueStore } from '../../core/cache/keyValueStore.js';

export interface Disposable {
  dispose(): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

export interface WorkspaceFolder {
  /** Stable identity. Persisted in cache keys, so it must not change between sessions. */
  readonly id: string;
  readonly name: string;
  /** Absolute path of the folder root. */
  readonly path: string;
}

export interface FileSearch {
  folder: WorkspaceFolder;
  /** Folder-relative directory to search under. Empty for the folder root. */
  dir: string;
  /** Glob relative to `dir`. */
  include: string;
  exclude: string;
  maxResults?: number;
}

export interface ProgressReporter {
  report(value: { message?: string; increment?: number }): void;
}

export interface QuickPickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

export interface QuickPickOptions {
  title: string;
  placeholder: string;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
}

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Shown as the name of the console the process runs in. */
  title: string;
  /** Groups related runs, such as one package's upgrade. */
  scope: string;
}

export interface RunningProcess {
  /** Fires once with the exit code, or undefined when the process ended without one. */
  onDidExit(listener: (exitCode: number | undefined) => void): Disposable;
}

/** One-based line and column. */
export interface FilePosition {
  line: number;
  column: number;
}

export interface HostPlatform {
  workspaceFolders(): readonly WorkspaceFolder[];
  isWorkspaceTrusted(): boolean;
  getSetting<T>(key: string, defaultValue: T): T;
  readonly workspaceState: KeyValueStore;
  readonly globalState: KeyValueStore;

  findFiles(search: FileSearch, token?: CancellationToken): Promise<string[]>;
  statFile(filePath: string): Promise<{ size: number }>;
  readFile(filePath: string): Promise<Uint8Array>;
  /** Calls `listener` when a file matching `glob` under `baseDir` is created, changed or deleted. */
  watchFiles(baseDir: string, glob: string, listener: (filePath: string) => void): Disposable;
  /** Undefined when HEAD cannot be observed for `projectPath`. */
  watchGitHead(projectPath: string, onHeadChanged: () => void): Promise<Disposable | undefined>;

  /** Shows cancellable progress while `task` runs. */
  withProgress<T>(title: string, task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>): Promise<T>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  showErrorMessage(message: string): void;
  /** Resolves to the chosen action, or undefined when dismissed. */
  showModalWarning(message: string, detail: string, actions: readonly string[]): Promise<string | undefined>;
  /** Resolves to the chosen item's value, or undefined when dismissed. */
  showQuickPick<T>(
    items: readonly QuickPickItem<T>[],
    options: QuickPickOptions,
    token?: CancellationToken
  ): Promise<T | undefined>;

  /** Starts the process where the user can watch its output. Rejects when it cannot start. */
  runProcess(request: ProcessRequest): Promise<RunningProcess>;
  /** Opens the file, placing the cursor at `position` when given. */
  openFile(filePath: string, position?: FilePosition): void;
  openExternal(url: string): void;
  openSettings(key: string): void;
}

/** The dashboard's message channel to the webview. */
export interface WebviewChannel {
  postMessage(message: unknown): void;
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  onDidDispose(listener: () => void): Disposable;
  reveal(): void;
}
