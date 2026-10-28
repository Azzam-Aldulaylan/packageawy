/** HostPlatform over the sidecar's JSON-RPC connection. See ../hostPlatform.ts for the protocol. */

import { readFile, stat } from 'node:fs/promises';

import type { KeyValueStore } from '../../../core/cache/keyValueStore.js';
import { CancellationTokenSource } from '../cancellation.js';
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
import { ErrorCodes, ResponseError } from './jsonRpc.js';
import type { JsonRpcConnection } from './jsonRpc.js';
import type {
  FilesFindParams,
  InitializeParams,
  OpenFileParams,
  ProcessStartParams,
  ShowMessageParams,
  ShowModalParams,
  ShowQuickPickParams,
  StorageSnapshot,
  StorageUpdateParams,
} from './protocol.js';
import { Methods } from './protocol.js';
import {
  parseDidChangeFolders,
  parseDidChangeSettings,
  parseDidChangeTrust,
  parseFileDidChange,
  parseIdParam,
  parseProcessDidExit,
} from './validation.js';

/** The connection surface RpcPlatform uses. JsonRpcConnection satisfies it. */
export type RpcConnection = Pick<JsonRpcConnection, 'sendRequest' | 'sendNotification' | 'onNotification'>;

type Log = (message: string) => void;

/** A local copy of one storage scope. Updates are written through to the client. */
class RpcStore implements KeyValueStore {
  private readonly values: Map<string, unknown>;

  constructor(
    private readonly connection: RpcConnection,
    private readonly scope: StorageUpdateParams['scope'],
    snapshot: StorageSnapshot
  ) {
    this.values = new Map(Object.entries(snapshot));
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    const params: StorageUpdateParams = value === undefined ? { scope: this.scope, key } : { scope: this.scope, key, value };
    await this.connection.sendRequest(Methods.storageUpdate, params);
  }
}

interface ProcessState {
  exited: boolean;
  exitCode: number | undefined;
  listeners: Set<(exitCode: number | undefined) => void>;
}

function isCancelled(error: unknown): boolean {
  return error instanceof ResponseError && error.code === ErrorCodes.RequestCancelled;
}

function callSoon(listener: () => void): Disposable {
  const handle = setTimeout(listener, 0);
  return { dispose: () => clearTimeout(handle) };
}

export class RpcPlatform implements HostPlatform {
  readonly workspaceState: KeyValueStore;
  readonly globalState: KeyValueStore;

  private folders: readonly WorkspaceFolder[];
  private trusted: boolean;
  private settings: Record<string, unknown>;
  private nextId = 1;
  private readonly fileWatches = new Map<number, (filePath: string) => void>();
  private readonly headWatches = new Map<number, () => void>();
  private readonly progress = new Map<number, CancellationTokenSource>();
  private readonly processes = new Map<number, ProcessState>();

  constructor(
    private readonly connection: RpcConnection,
    init: InitializeParams,
    private readonly log: Log = () => undefined
  ) {
    this.folders = init.workspaceFolders;
    this.trusted = init.isWorkspaceTrusted;
    this.settings = { ...init.settings };
    this.workspaceState = new RpcStore(connection, 'workspace', init.workspaceState);
    this.globalState = new RpcStore(connection, 'global', init.globalState);

    connection.onNotification(Methods.didChangeFolders, (params) => {
      this.folders = parseDidChangeFolders(params).workspaceFolders;
    });
    connection.onNotification(Methods.didChangeTrust, (params) => {
      this.trusted = parseDidChangeTrust(params).isWorkspaceTrusted;
    });
    connection.onNotification(Methods.didChangeSettings, (params) => {
      this.settings = { ...parseDidChangeSettings(params).settings };
    });
    connection.onNotification(Methods.filesDidChange, (params) => {
      const { watchId, path } = parseFileDidChange(params);
      this.fileWatches.get(watchId)?.(path);
    });
    connection.onNotification(Methods.gitDidChangeHead, (params) => {
      this.headWatches.get(parseIdParam(params, 'watchId'))?.();
    });
    connection.onNotification(Methods.progressCancel, (params) => {
      this.progress.get(parseIdParam(params, 'progressId'))?.cancel();
    });
    connection.onNotification(Methods.processDidExit, (params) => {
      const { processId, exitCode } = parseProcessDidExit(params);
      const state = this.processes.get(processId);
      if (state === undefined) return;
      this.processes.delete(processId);
      state.exited = true;
      state.exitCode = exitCode ?? undefined;
      const listeners = [...state.listeners];
      state.listeners.clear();
      for (const listener of listeners) listener(state.exitCode);
    });
  }

  workspaceFolders(): readonly WorkspaceFolder[] {
    return this.folders;
  }

  isWorkspaceTrusted(): boolean {
    return this.trusted;
  }

  getSetting<T>(key: string, defaultValue: T): T {
    const value = this.settings[key];
    return value === undefined || value === null ? defaultValue : (value as T);
  }

  async findFiles(search: FileSearch, token?: CancellationToken): Promise<string[]> {
    if (token?.isCancellationRequested) return [];
    const params: FilesFindParams = {
      folder: { id: search.folder.id, name: search.folder.name, path: search.folder.path },
      dir: search.dir,
      include: search.include,
      exclude: search.exclude,
      ...(search.maxResults === undefined ? {} : { maxResults: search.maxResults }),
    };
    try {
      const result = await this.connection.sendRequest<unknown>(Methods.filesFind, params, token);
      if (!Array.isArray(result) || !result.every((item) => typeof item === 'string')) {
        throw new Error('files/find returned an invalid result');
      }
      // Like VS Code, a cancelled search resolves with no results.
      if (token?.isCancellationRequested) return [];
      return search.maxResults === undefined ? result : result.slice(0, search.maxResults);
    } catch (error) {
      if (isCancelled(error)) return [];
      throw error;
    }
  }

  async statFile(filePath: string): Promise<{ size: number }> {
    const info = await stat(filePath);
    return { size: info.size };
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    return readFile(filePath);
  }

  watchFiles(baseDir: string, glob: string, listener: (filePath: string) => void): Disposable {
    const watchId = this.nextId++;
    this.fileWatches.set(watchId, listener);
    this.connection.sendRequest(Methods.filesWatch, { watchId, baseDir, glob }).catch((error: unknown) => {
      this.log(`files/watch failed for ${baseDir}: ${String(error)}`);
    });
    return {
      dispose: () => {
        if (!this.fileWatches.delete(watchId)) return;
        this.connection.sendNotification(Methods.filesUnwatch, { watchId });
      },
    };
  }

  async watchGitHead(projectPath: string, onHeadChanged: () => void): Promise<Disposable | undefined> {
    const watchId = this.nextId++;
    this.headWatches.set(watchId, onHeadChanged);
    let observed: unknown;
    try {
      observed = await this.connection.sendRequest<unknown>(Methods.gitWatchHead, { watchId, projectPath });
    } catch {
      observed = false;
    }
    if (observed !== true) {
      this.headWatches.delete(watchId);
      return undefined;
    }
    return {
      dispose: () => {
        if (!this.headWatches.delete(watchId)) return;
        this.connection.sendNotification(Methods.gitUnwatchHead, { watchId });
      },
    };
  }

  async withProgress<T>(
    title: string,
    task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
  ): Promise<T> {
    const progressId = this.nextId++;
    const source = new CancellationTokenSource();
    this.progress.set(progressId, source);
    this.connection.sendNotification(Methods.progressStart, { progressId, title, cancellable: true });
    const reporter: ProgressReporter = {
      report: (value) => {
        this.connection.sendNotification(Methods.progressReport, {
          progressId,
          ...(value.message === undefined ? {} : { message: value.message }),
          ...(value.increment === undefined ? {} : { increment: value.increment }),
        });
      },
    };
    try {
      return await task(reporter, source.token);
    } finally {
      this.progress.delete(progressId);
      source.dispose();
      this.connection.sendNotification(Methods.progressEnd, { progressId });
    }
  }

  showInformationMessage(message: string): void {
    this.showMessage('info', message);
  }

  showWarningMessage(message: string): void {
    this.showMessage('warning', message);
  }

  showErrorMessage(message: string): void {
    this.showMessage('error', message);
  }

  async showModalWarning(message: string, detail: string, actions: readonly string[]): Promise<string | undefined> {
    const params: ShowModalParams = { message, detail, actions: [...actions] };
    const choice = await this.connection.sendRequest<unknown>(Methods.showModal, params);
    // Only an action we offered counts as a choice.
    return typeof choice === 'string' && actions.includes(choice) ? choice : undefined;
  }

  async showQuickPick<T>(
    items: readonly QuickPickItem<T>[],
    options: QuickPickOptions,
    token?: CancellationToken
  ): Promise<T | undefined> {
    if (token?.isCancellationRequested) return undefined;
    const params: ShowQuickPickParams = {
      items: items.map((item) => ({
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      })),
      options: {
        title: options.title,
        placeholder: options.placeholder,
        matchOnDescription: options.matchOnDescription,
        matchOnDetail: options.matchOnDetail,
      },
    };
    let index: unknown;
    try {
      index = await this.connection.sendRequest<unknown>(Methods.showQuickPick, params, token);
    } catch (error) {
      if (isCancelled(error)) return undefined;
      throw error;
    }
    if (token?.isCancellationRequested) return undefined;
    if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
    return items[index]?.value;
  }

  async runProcess(request: ProcessRequest): Promise<RunningProcess> {
    const processId = this.nextId++;
    const state: ProcessState = { exited: false, exitCode: undefined, listeners: new Set() };
    // Registered before the request so an early exit is not lost.
    this.processes.set(processId, state);
    const params: ProcessStartParams = {
      processId,
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      title: request.title,
      scope: request.scope,
    };
    try {
      await this.connection.sendRequest(Methods.processStart, params);
    } catch (error) {
      this.processes.delete(processId);
      throw error;
    }
    return {
      onDidExit: (listener) => {
        if (state.exited) return callSoon(() => listener(state.exitCode));
        state.listeners.add(listener);
        return { dispose: () => state.listeners.delete(listener) };
      },
    };
  }

  openFile(filePath: string, position?: FilePosition): void {
    const params: OpenFileParams =
      position === undefined ? { path: filePath } : { path: filePath, position: { line: position.line, column: position.column } };
    this.connection.sendNotification(Methods.openFile, params);
  }

  openExternal(url: string): void {
    this.connection.sendNotification(Methods.openExternal, { url });
  }

  openSettings(key: string): void {
    this.connection.sendNotification(Methods.openSettings, { key });
  }

  private showMessage(severity: ShowMessageParams['severity'], message: string): void {
    const params: ShowMessageParams = { severity, message };
    this.connection.sendNotification(Methods.showMessage, params);
  }
}
