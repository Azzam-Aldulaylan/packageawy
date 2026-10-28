/**
 * JSON-RPC 2.0 over a byte stream with LSP-style Content-Length framing.
 * Both sides may send requests, notifications and `$/cancelRequest`.
 */

import type { Readable, Writable } from 'node:stream';

import { CancellationTokenSource } from '../cancellation.js';
import type { CancellationToken, Disposable } from '../hostPlatform.js';

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
} as const;

export type RequestId = number | string;

export interface ResponseErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class ResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ResponseError';
    this.code = code;
    this.data = data;
  }
}

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
/** Large enough for any dashboard payload, small enough to stop a runaway header. */
const MAX_CONTENT_LENGTH = 256 * 1024 * 1024;

/** Encodes one message as a framed buffer. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** Splits a byte stream into message bodies. Throws on a malformed header. */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const bodies: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) break;
      const length = parseContentLength(this.buffer.subarray(0, headerEnd).toString('ascii'));
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + length) break;
      bodies.push(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    return bodies;
  }
}

function parseContentLength(header: string): number {
  let length: number | undefined;
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`Malformed header line: ${line}`);
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(value)) throw new Error(`Invalid Content-Length: ${value}`);
    length = Number(value);
  }
  if (length === undefined) throw new Error('Missing Content-Length header');
  if (length > MAX_CONTENT_LENGTH) throw new Error(`Content-Length too large: ${length}`);
  return length;
}

type RequestHandler = (params: unknown, token: CancellationToken) => unknown;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'number' || typeof value === 'string';
}

export class JsonRpcConnection {
  private readonly decoder = new MessageDecoder();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly incoming = new Map<RequestId, CancellationTokenSource>();
  private readonly closeListeners = new Set<() => void>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  /** Starts reading. Call after registering handlers. */
  listen(): void {
    this.input.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    this.input.on('end', () => this.close());
    this.input.on('close', () => this.close());
    this.input.on('error', () => this.close());
    this.output.on('error', () => this.close());
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onClose(listener: () => void): Disposable {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  sendNotification(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** Cancelling `token` sends `$/cancelRequest`. The promise still settles with the peer's answer. */
  sendRequest<T>(method: string, params?: unknown, token?: CancellationToken): Promise<T> {
    if (this.closed) return Promise.reject(new ResponseError(ErrorCodes.InternalError, 'Connection is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let subscription: Disposable | undefined;
      this.pending.set(id, {
        resolve: (value) => {
          subscription?.dispose();
          resolve(value as T);
        },
        reject: (error) => {
          subscription?.dispose();
          reject(error);
        },
      });
      const message = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
      this.write(message);
      if (token !== undefined) {
        const sendCancel = (): void => {
          if (this.pending.has(id)) this.sendNotification('$/cancelRequest', { id });
        };
        if (token.isCancellationRequested) sendCancel();
        else subscription = token.onCancellationRequested(sendCancel);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new ResponseError(ErrorCodes.InternalError, 'Connection closed');
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const source of this.incoming.values()) source.cancel();
    this.incoming.clear();
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
  }

  private write(message: unknown): void {
    if (this.closed) return;
    this.output.write(encodeMessage(message));
  }

  private onData(chunk: Buffer): void {
    let bodies: string[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (error) {
      // The stream can't be resynchronised after a bad header.
      this.log(`Closing connection: ${String(error)}`);
      this.close();
      return;
    }
    for (const body of bodies) this.onBody(body);
  }

  private onBody(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.ParseError, message: 'Parse error' } });
      return;
    }
    if (!isRecord(message) || message['jsonrpc'] !== '2.0') {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.InvalidRequest, message: 'Invalid request' } });
      return;
    }
    const method = message['method'];
    if (typeof method === 'string') {
      if ('id' in message && isRequestId(message['id'])) this.onIncomingRequest(message['id'], method, message['params']);
      else if ('id' in message) this.write({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.InvalidRequest, message: 'Invalid request id' } });
      else this.onIncomingNotification(method, message['params']);
      return;
    }
    if (isRequestId(message['id'])) this.onResponse(message['id'], message);
  }

  private onResponse(id: RequestId, message: Record<string, unknown>): void {
    const request = this.pending.get(id);
    if (request === undefined) return;
    this.pending.delete(id);
    const error = message['error'];
    if (isRecord(error)) {
      const code = typeof error['code'] === 'number' ? error['code'] : ErrorCodes.InternalError;
      const text = typeof error['message'] === 'string' ? error['message'] : 'Request failed';
      request.reject(new ResponseError(code, text, error['data']));
      return;
    }
    request.resolve(message['result'] ?? null);
  }

  private onIncomingNotification(method: string, params: unknown): void {
    if (method === '$/cancelRequest') {
      const id = isRecord(params) ? params['id'] : undefined;
      if (isRequestId(id)) this.incoming.get(id)?.cancel();
      return;
    }
    const handler = this.notificationHandlers.get(method);
    if (handler === undefined) return;
    try {
      handler(params);
    } catch (error) {
      this.log(`Notification ${method} failed: ${String(error)}`);
    }
  }

  private onIncomingRequest(id: RequestId, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      this.write({ jsonrpc: '2.0', id, error: { code: ErrorCodes.MethodNotFound, message: `Unknown method: ${method}` } });
      return;
    }
    const source = new CancellationTokenSource();
    this.incoming.set(id, source);
    void (async () => {
      try {
        const result = await handler(params, source.token);
        if (source.token.isCancellationRequested) {
          this.writeError(id, new ResponseError(ErrorCodes.RequestCancelled, 'Request cancelled'));
        } else {
          this.write({ jsonrpc: '2.0', id, result: result ?? null });
        }
      } catch (error) {
        this.writeError(id, error);
      } finally {
        this.incoming.delete(id);
        source.dispose();
      }
    })();
  }

  private writeError(id: RequestId, error: unknown): void {
    const body: ResponseErrorObject =
      error instanceof ResponseError
        ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
        : { code: ErrorCodes.InternalError, message: error instanceof Error ? error.message : String(error) };
    this.write({ jsonrpc: '2.0', id, error: body });
  }
}
