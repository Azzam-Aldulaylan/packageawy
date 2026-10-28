/** JSON-RPC transport: Content-Length framing, requests, responses, errors and cancellation. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { encodeMessage, ErrorCodes, JsonRpcConnection, MessageDecoder, ResponseError } from '../out/host/platform/rpc/jsonRpc.js';
import { CancellationTokenSource } from '../out/host/platform/cancellation.js';

function frame(text) {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

/** Two connections wired back to back. */
function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcConnection(bToA, aToB);
  const b = new JsonRpcConnection(aToB, bToA);
  return { a, b, aToB, bToA };
}

/** A connection plus the raw messages it writes. */
function raw() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MessageDecoder();
  const written = [];
  const waiters = [];
  output.on('data', (chunk) => {
    for (const body of decoder.push(chunk)) written.push(JSON.parse(body));
    for (const waiter of waiters.splice(0)) waiter();
  });
  const connection = new JsonRpcConnection(input, output);
  return {
    connection,
    written,
    send: (message) => input.write(encodeMessage(message)),
    input,
    next: async (count = 1) => {
      while (written.length < count) await new Promise((resolve) => waiters.push(resolve));
      return written[count - 1];
    },
  };
}

test('encodeMessage writes the byte length of the UTF-8 body', () => {
  const encoded = encodeMessage({ text: 'héllo ✓' }).toString('utf8');
  const [header, body] = encoded.split('\r\n\r\n');
  assert.equal(header, `Content-Length: ${Buffer.byteLength(body)}`);
  assert.deepEqual(JSON.parse(body), { text: 'héllo ✓' });
});

test('MessageDecoder handles split frames, multibyte splits and several frames per chunk', () => {
  const decoder = new MessageDecoder();
  const one = frame('{"a":"✓✓"}');
  const two = frame('{"b":2}');
  const all = Buffer.concat([one, two]);
  const bodies = [];
  // Feed byte by byte, which splits headers and multibyte characters.
  for (let i = 0; i < all.length; i += 1) bodies.push(...decoder.push(all.subarray(i, i + 1)));
  assert.deepEqual(bodies, ['{"a":"✓✓"}', '{"b":2}']);
  assert.deepEqual(new MessageDecoder().push(all), ['{"a":"✓✓"}', '{"b":2}']);
});

test('MessageDecoder accepts extra headers in any case', () => {
  const decoder = new MessageDecoder();
  const body = '{"x":1}';
  const chunk = Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  assert.deepEqual(decoder.push(chunk), [body]);
});

test('MessageDecoder rejects a missing or invalid Content-Length', () => {
  assert.throws(() => new MessageDecoder().push(Buffer.from('X-Other: 1\r\n\r\n{}')), /Missing Content-Length/);
  assert.throws(() => new MessageDecoder().push(Buffer.from('Content-Length: abc\r\n\r\n{}')), /Invalid Content-Length/);
});

test('requests and notifications round-trip in both directions', async () => {
  const { a, b } = pair();
  const seen = [];
  b.onRequest('math/add', (params) => params.x + params.y);
  b.onNotification('log', (params) => seen.push(params));
  a.onRequest('ping', () => 'pong');
  a.listen();
  b.listen();

  assert.equal(await a.sendRequest('math/add', { x: 2, y: 3 }), 5);
  assert.equal(await b.sendRequest('ping'), 'pong');
  a.sendNotification('log', { line: 'hi' });
  await a.sendRequest('math/add', { x: 0, y: 0 });
  assert.deepEqual(seen, [{ line: 'hi' }]);
});

test('an undefined handler result is sent as null', async () => {
  const { a, b } = pair();
  b.onRequest('nothing', () => undefined);
  a.listen();
  b.listen();
  assert.equal(await a.sendRequest('nothing'), null);
});

test('unknown methods get MethodNotFound and handler errors become error responses', async () => {
  const { a, b } = pair();
  b.onRequest('boom', () => {
    throw new Error('it broke');
  });
  b.onRequest('typed', () => {
    throw new ResponseError(ErrorCodes.InvalidParams, 'bad params', { field: 'x' });
  });
  a.listen();
  b.listen();

  await assert.rejects(a.sendRequest('nope'), (error) => error.code === ErrorCodes.MethodNotFound);
  await assert.rejects(a.sendRequest('boom'), (error) => error.code === ErrorCodes.InternalError && error.message === 'it broke');
  await assert.rejects(
    a.sendRequest('typed'),
    (error) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams && error.data.field === 'x'
  );
});

test('invalid JSON and non 2.0 messages get error responses with a null id', async () => {
  const peer = raw();
  peer.connection.listen();
  peer.input.write(frame('{not json'));
  assert.deepEqual(await peer.next(1), { jsonrpc: '2.0', id: null, error: { code: ErrorCodes.ParseError, message: 'Parse error' } });
  peer.send({ jsonrpc: '1.0', id: 1, method: 'x' });
  assert.equal((await peer.next(2)).error.code, ErrorCodes.InvalidRequest);
});

test('cancelling an outgoing request sends $/cancelRequest and surfaces the peer answer', async () => {
  const peer = raw();
  peer.connection.listen();
  const source = new CancellationTokenSource();
  const result = peer.connection.sendRequest('slow', { n: 1 }, source.token);
  const request = await peer.next(1);
  assert.equal(request.method, 'slow');
  source.cancel();
  assert.deepEqual(await peer.next(2), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: request.id } });
  peer.send({ jsonrpc: '2.0', id: request.id, error: { code: ErrorCodes.RequestCancelled, message: 'cancelled' } });
  await assert.rejects(result, (error) => error.code === ErrorCodes.RequestCancelled);
});

test('an already cancelled token still sends the request, then cancels it', async () => {
  const peer = raw();
  peer.connection.listen();
  const source = new CancellationTokenSource();
  source.cancel();
  const result = peer.connection.sendRequest('slow', {}, source.token);
  const request = await peer.next(1);
  assert.equal((await peer.next(2)).method, '$/cancelRequest');
  peer.send({ jsonrpc: '2.0', id: request.id, result: [] });
  assert.deepEqual(await result, []);
});

test('$/cancelRequest cancels the incoming handler token and answers RequestCancelled', async () => {
  const peer = raw();
  let release;
  let tokenSeen;
  peer.connection.onRequest('slow', (_params, token) => {
    tokenSeen = token;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  peer.connection.listen();
  peer.send({ jsonrpc: '2.0', id: 'r1', method: 'slow' });
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  peer.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'r1' } });
  while (!tokenSeen.isCancellationRequested) await new Promise((resolve) => setImmediate(resolve));
  release('late');
  const response = await peer.next(1);
  assert.equal(response.id, 'r1');
  assert.equal(response.error.code, ErrorCodes.RequestCancelled);
});

test('closing the input rejects pending requests and fires onClose', async () => {
  const peer = raw();
  peer.connection.listen();
  let closed = false;
  peer.connection.onClose(() => {
    closed = true;
  });
  const result = peer.connection.sendRequest('never');
  await peer.next(1);
  peer.input.end();
  await assert.rejects(result, /Connection closed/);
  assert.equal(closed, true);
  assert.equal(peer.connection.isClosed, true);
  await assert.rejects(peer.connection.sendRequest('after'), /closed/);
});

test('a malformed header closes the connection', async () => {
  const peer = raw();
  peer.connection.listen();
  const closed = new Promise((resolve) => peer.connection.onClose(resolve));
  peer.input.write(Buffer.from('garbage\r\n\r\n'));
  await closed;
  assert.equal(peer.connection.isClosed, true);
});

test('responses for unknown ids are ignored', async () => {
  const { a, b } = pair();
  b.onRequest('echo', (params) => params);
  a.listen();
  b.listen();
  const peer = raw();
  peer.connection.listen();
  peer.send({ jsonrpc: '2.0', id: 999, result: 'stray' });
  assert.deepEqual(await a.sendRequest('echo', { ok: true }), { ok: true });
  assert.equal(peer.written.length, 0);
});
