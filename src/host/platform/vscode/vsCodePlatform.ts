/** HostPlatform on the VS Code extension API. */

import { isRecoveryPath } from '../../../core/workspace/scan.js';
import { readFileSync } from 'node:fs';
import { readFileChunks } from '../fileChunks.js';

import * as vscode from 'vscode';

import type { KeyValueStore } from '../../../core/cache/keyValueStore.js';
import type {
  CancellationToken,
  Disposable,
  FilePosition,
  FileSearch,
  HostPlatform,
  ProcessRequest,
  ProgressReporter,
  QuickPickItem,
  QuickPickOptions,
  RunningProcess,
  WorkspaceFolder,
} from '../hostPlatform.js';
import { REGISTRY_CACHE_STORAGE_KEY } from '../../../core/cache/persistentEtagStore.js';
import { editorActionFailureText, runtimeFailureLine } from '../../../core/diagnostics.js';
import type { RuntimeFailureContext } from '../../../core/diagnostics.js';
import { fireAndForget } from '../../../core/fireAndForget.js';
import { createCacheStore, migrateStoreKeys } from '../fileKeyValueStore.js';
import { watchGitHead } from './gitHead.js';
import { openScopedSettings } from './settingsScope.js';

const SETTINGS_SECTION = 'packageawy';

/** A VS Code token that follows `token`, for APIs that need the real type. */
function toVsCodeToken(token: CancellationToken | undefined): {
  token: vscode.CancellationToken | undefined;
  dispose(): void;
} {
  if (token === undefined) return { token: undefined, dispose: () => undefined };
  const source = new vscode.CancellationTokenSource();
  if (token.isCancellationRequested) source.cancel();
  const subscription = token.onCancellationRequested(() => source.cancel());
  return {
    token: source.token,
    dispose: () => {
      subscription.dispose();
      source.dispose();
    },
  };
}

/**
 * The exit of one task Packageawy started. Subscribed before the task starts,
 * so an exit that arrives before executeTask resolves is kept, and replayed
 * to a caller that subscribes after the process already ended.
 */
class TaskRun {
  private native: vscode.Disposable | undefined;
  private execution: vscode.TaskExecution | undefined;
  /** Exits seen before startup resolved. Which one is ours is only known after. */
  private readonly early = new Map<vscode.TaskExecution, { exitCode: number | undefined }>();
  private exit: { exitCode: number | undefined } | undefined;
  private disposed = false;
  private resolveTeardown: () => void = () => undefined;
  readonly teardown = new Promise<void>((resolve) => { this.resolveTeardown = resolve; });
  private readonly listeners = new Set<(exitCode: number | undefined) => void>();
  private readonly replays = new Map<ReturnType<typeof setTimeout>, (exitCode: number | undefined) => void>();

  constructor() {
    // onDidEndTaskProcess fires for every task in the workspace, so events are matched by execution.
    this.native = vscode.tasks.onDidEndTaskProcess((event) => {
      if (this.execution === undefined) {
        if (!this.early.has(event.execution)) this.early.set(event.execution, { exitCode: event.exitCode });
        return;
      }
      if (event.execution === this.execution) this.finish(event.exitCode);
    });
  }

  started(execution: vscode.TaskExecution): void {
    if (this.disposed) {
      // A late launch must not keep mutating after observation was lost.
      try { execution.terminate(); } catch { /* Teardown still settles if the task already ended. */ }
      return;
    }
    this.execution = execution;
    const early = this.early.get(execution);
    this.early.clear();
    if (early !== undefined) this.finish(early.exitCode);
  }

  onDidExit(listener: (exitCode: number | undefined) => void): Disposable {
    if (this.disposed) {
      const replay = setTimeout(() => listener(undefined), 0);
      return { dispose: () => clearTimeout(replay) };
    }
    const exit = this.exit;
    if (exit !== undefined) {
      // Never synchronously: callers assign the returned disposable after subscribing.
      const handle = setTimeout(() => {
        this.replays.delete(handle);
        if (!this.disposed) listener(exit.exitCode);
      }, 0);
      this.replays.set(handle, (exitCode) => listener(exitCode));
      return {
        dispose: () => {
          clearTimeout(handle);
          this.replays.delete(handle);
        },
      };
    }
    // A wrapper per subscription, so the same function subscribed twice is called twice.
    const entry = (exitCode: number | undefined): void => listener(exitCode);
    this.listeners.add(entry);
    return { dispose: () => this.listeners.delete(entry) };
  }

  /** Stops listening for exits. The process itself is never terminated here. */
  stopObserving(): void {
    this.native?.dispose();
    this.native = undefined;
    this.early.clear();
  }

  /** Teardown settles undelivered results as unknown, including queued replays. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveTeardown();
    this.stopObserving();
    for (const [handle, listener] of this.replays) {
      clearTimeout(handle);
      this.listeners.add(listener);
    }
    this.replays.clear();
    this.deliver(undefined);
  }

  private finish(exitCode: number | undefined): void {
    if (this.exit !== undefined || this.disposed) return;
    this.exit = { exitCode };
    this.stopObserving();
    this.deliver(exitCode);
  }

  private deliver(exitCode: number | undefined): void {
    // Remove each observer only as it is delivered. Reentrant disposal can
    // then settle every remaining observer as unknown exactly once.
    for (const listener of this.listeners) {
      this.listeners.delete(listener);
      listener(this.disposed ? undefined : exitCode);
    }
  }
}

export class VsCodePlatform implements HostPlatform {
  readFileChunks = readFileChunks;
  readonly hostKind = 'vscode';
  /** Created on first use so a session with no failures adds no output channel. */
  private logChannel: vscode.LogOutputChannel | undefined;
  /** Every task run until the platform is disposed, so teardown can stop late callbacks. */
  private readonly taskRuns = new Set<TaskRun>();
  private disposed = false;
  readonly workspaceState: KeyValueStore;
  readonly globalState: KeyValueStore;
  readonly cacheStore: KeyValueStore;

  constructor(context: Pick<vscode.ExtensionContext, 'workspaceState' | 'globalState' | 'globalStorageUri'>) {
    this.workspaceState = context.workspaceState;
    this.globalState = context.globalState;
    // Registry responses live in files under the extension's global storage
    // folder, not in global state, which VS Code loads as one value.
    // When that folder cannot be written, the cache stays in global state.
    const cache = createCacheStore(vscode.Uri.joinPath(context.globalStorageUri, 'cache').fsPath, context.globalState);
    this.cacheStore = cache.store;
    if (cache.fileBacked) {
      migrateStoreKeys(context.globalState, this.cacheStore, [REGISTRY_CACHE_STORAGE_KEY]).catch(() => undefined);
    }
  }

  log(line: string): void {
    this.channel().warn(line);
  }

  /** Opens the Packageawy log (Packageawy: Show Log). */
  showLog(): void {
    this.channel().show(true);
  }

  dispose(): void {
    this.disposed = true;
    this.logChannel?.dispose();
    this.logChannel = undefined;
    for (const run of this.taskRuns) run.dispose();
    this.taskRuns.clear();
  }

  private channel(): vscode.LogOutputChannel {
    this.logChannel ??= vscode.window.createOutputChannel('Packageawy', { log: true });
    return this.logChannel;
  }

  workspaceFolders(): readonly WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      id: folder.uri.toString(),
      name: folder.name,
      path: folder.uri.fsPath,
    }));
  }

  isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  getSetting<T>(key: string, defaultValue: T, resourcePath?: string): T {
    const scope = resourcePath === undefined ? undefined : vscode.Uri.file(resourcePath);
    return vscode.workspace.getConfiguration(SETTINGS_SECTION, scope).get<T>(key, defaultValue);
  }

  onDidChangeSetting(key: string, listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.${key}`)) listener();
    });
  }

  async updateWorkspaceSetting(key: string, value: unknown): Promise<void> {
    // getSetting reads without a resource scope, so the workspace target is
    // the value it sees, in single-folder and multi-root windows alike.
    await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  async findFiles(search: FileSearch, token?: CancellationToken): Promise<string[]> {
    const folderUri = vscode.Uri.parse(search.folder.id);
    const base = search.dir === '' ? folderUri : vscode.Uri.joinPath(folderUri, search.dir);
    const cancellation = toVsCodeToken(token);
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(base, search.include),
        search.exclude,
        search.maxResults,
        cancellation.token
      );
      return uris.map((uri) => uri.fsPath);
    } finally {
      cancellation.dispose();
    }
  }

  async statFile(filePath: string): Promise<{ size: number }> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return { size: stat.size };
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  }

  watchFiles(baseDir: string, glob: string, listener: (filePath: string) => void): Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(baseDir), glob));
    const onEvent = (uri: vscode.Uri): void => { if (!isRecoveryPath(uri.fsPath)) listener(uri.fsPath); };
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watcher.onDidDelete(onEvent);
    return watcher;
  }

  watchGitHead(projectPath: string, onHeadChanged: () => void): Promise<Disposable | undefined> {
    return watchGitHead(projectPath, onHeadChanged);
  }

  async withProgress<T>(
    title: string,
    task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => task(progress, token)
    );
  }

  // A notification that fails to show has nowhere else to go, so it is only logged.
  showInformationMessage(message: string): void {
    fireAndForget(vscode.window.showInformationMessage(message), this.logFailure('notification'));
  }

  showWarningMessage(message: string): void {
    fireAndForget(vscode.window.showWarningMessage(message), this.logFailure('notification'));
  }

  showErrorMessage(message: string): void {
    fireAndForget(vscode.window.showErrorMessage(message), this.logFailure('notification'));
  }

  private logFailure(context: RuntimeFailureContext): (error: unknown) => undefined {
    return (error) => {
      this.log(runtimeFailureLine(context, error));
    };
  }

  /** The user asked for this, so a refusal is logged and also said once. */
  private reportEditorActionFailure(action: 'open-file' | 'open-link' | 'open-settings'): (error: unknown) => undefined {
    return (error) => {
      this.log(runtimeFailureLine(action, error));
      this.showErrorMessage(editorActionFailureText(action));
    };
  }

  async showModalWarning(message: string, detail: string, actions: readonly string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions);
  }

  async showQuickPick<T>(
    items: readonly QuickPickItem<T>[],
    options: QuickPickOptions,
    token?: CancellationToken
  ): Promise<T | undefined> {
    const cancellation = toVsCodeToken(token);
    try {
      const picked = await vscode.window.showQuickPick(
        items,
        {
          title: options.title,
          placeHolder: options.placeholder,
          matchOnDescription: options.matchOnDescription,
          matchOnDetail: options.matchOnDetail,
        },
        cancellation.token
      );
      return picked?.value;
    } finally {
      cancellation.dispose();
    }
  }

  async runProcess(request: ProcessRequest): Promise<RunningProcess> {
    if (this.disposed) throw new Error('The platform is disposed.');
    const execution = new vscode.ProcessExecution(request.executable, [...request.args], { cwd: request.cwd });
    const task = new vscode.Task(
      { type: 'packageawy.upgrade', package: request.scope },
      vscode.TaskScope.Workspace,
      request.title,
      'Packageawy',
      execution
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    // Listening starts before the task does: a process that exits before
    // executeTask resolves, or before the caller subscribes, is still seen.
    const run = new TaskRun();
    this.taskRuns.add(run);
    try {
      // Teardown must release the observer even if executeTask never answers.
      // Keep the launch handler attached so a late task is fenced and stopped.
      await Promise.race([
        Promise.resolve(vscode.tasks.executeTask(task)).then((started) => run.started(started)),
        run.teardown,
      ]);
    } catch (error) {
      run.stopObserving();
      if (!this.disposed) throw error;
    }
    return { onDidExit: (listener) => run.onDidExit(listener) };
  }

  openFile(filePath: string, position?: FilePosition): void {
    fireAndForget(vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
      if (position === undefined) return;
      const start = new vscode.Position(Math.max(0, position.line - 1), Math.max(0, position.column - 1));
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenter);
    }), this.reportEditorActionFailure('open-file'));
  }

  openExternal(url: string): void {
    // VS Code reports a link it could not open as a resolved false, not only as a rejection.
    const reportFailure = this.reportEditorActionFailure('open-link');
    fireAndForget(vscode.env.openExternal(vscode.Uri.parse(url)).then((opened) => {
      if (!opened) reportFailure(new Error('The editor did not open the link.'));
    }), reportFailure);
  }

  openSettings(key: string, resourcePath?: string): void {
    const fullKey = `${SETTINGS_SECTION}.${key}`;
    if (resourcePath === undefined) {
      fireAndForget(
        vscode.commands.executeCommand('workbench.action.openSettings', fullKey),
        this.reportEditorActionFailure('open-settings')
      );
      return;
    }
    openScopedSettings(
      {
        inspect: (resource) => vscode.workspace.getConfiguration(SETTINGS_SECTION, vscode.Uri.file(resource)).inspect(key),
        // A .code-workspace file means separate workspace and folder settings.
        multiRoot: vscode.workspace.workspaceFile !== undefined,
        workspaceFolderFor: (resource) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resource))?.uri.fsPath,
        readFile: (filePath) => {
          try {
            return readFileSync(filePath, 'utf8');
          } catch {
            return undefined;
          }
        },
        executeCommand: (command, argument) => {
          fireAndForget(vscode.commands.executeCommand(command, argument), this.reportEditorActionFailure('open-settings'));
        },
        openFile: (filePath, position) => this.openFile(filePath, position),
      },
      fullKey,
      resourcePath
    );
  }
}
