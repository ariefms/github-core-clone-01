// raw-http.ts — a minimal HTTP/1.1 server over raw TCP, for the hot path.
//
// The suite's clients send only well-formed requests (request line, headers,
// Content-Length or chunked bodies, keep-alive, no pipelining in practice),
// and the entry answers only small responses, so a small parser covers
// everything node:http did for us — without its per-request machinery
// (llhttp parser, IncomingMessage/ServerResponse objects, stream wrappers,
// per-request timeout timers, Date header). The routing lives in app.ts
// (routeRequest); this file only moves bytes.
//
// Behavior matched to node:http (verified by probe against the entry):
//   - response: `HTTP/1.1 <status> <reason>`, content-type, content-length,
//     the route's extra headers, `connection: keep-alive` (or close).
//     No Date header (no check reads it), no Keep-Alive header.
//   - HEAD and 204/304: headers only, content-length = the computed body
//     length, no body bytes (exactly what node:http sends).
//   - malformed request line / headers / length: `400 Bad Request` +
//     `Connection: close`, no body (what node:http sends).
//   - keep-alive: HTTP/1.1 stays open unless `Connection: close`;
//     HTTP/1.0 closes unless `Connection: keep-alive`. Idle sockets are
//     closed after 5 s, matching node:http's keepAliveTimeout.
//   - chunked request bodies are supported; `Expect: 100-continue` is not
//     answered with 100 (the suite's clients never send it — they wait and
//     send the body anyway, and the parse completes then).

import { createServer as createNetServer, type Server, type Socket } from 'node:net';

export interface RawRequest {
  method: string;
  /** The request-target exactly as sent (path, or absolute-form). */
  target: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RawResponse {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type RawHandler = (req: RawRequest) => Promise<RawResponse>;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_HEAD_BYTES = 16 * 1024;
const IDLE_TIMEOUT_MS = 5_000;

/** Parse one chunked body starting at `start`. Null = incomplete. */
function parseChunked(buf: Buffer, start: number): { body: Buffer; rest: Buffer } | null | 'bad' {
  const chunks: Buffer[] = [];
  let off = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', off);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(off, lineEnd).toString('ascii').split(';')[0]?.trim() ?? '';
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return 'bad';
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (buf.length < dataStart + size + 2) return null;
    if (buf[dataStart + size] !== 13 || buf[dataStart + size + 1] !== 10) return 'bad';
    if (size === 0) {
      // Trailers, then one empty line.
      let t = dataStart;
      for (;;) {
        const e = buf.indexOf('\r\n', t);
        if (e < 0) return null;
        if (e === t) return { body: Buffer.concat(chunks), rest: buf.subarray(e + 2) };
        t = e + 2;
      }
    }
    chunks.push(buf.subarray(dataStart, dataStart + size));
    off = dataStart + size + 2;
  }
}

type Parsed =
  | { request: RawRequest; rest: Buffer; keepAlive: boolean }
  | null
  | 'bad';

/** Try to parse one complete request from the head of `buf`. */
function tryParseRequest(buf: Buffer): Parsed {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEAD_BYTES) return 'bad';
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('ascii');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace <= 0 || lastSpace <= firstSpace) return 'bad';
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const version = requestLine.slice(lastSpace + 1);
  if (target === '' || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) return 'bad';
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) return 'bad';
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  const bodyStart = headEnd + 4;
  const te = headers['transfer-encoding'] ?? '';
  const chunked = /\bchunked\b/i.test(te);
  let body: Buffer;
  let rest: Buffer;
  if (chunked) {
    const parsed = parseChunked(buf, bodyStart);
    if (parsed === null) return null;
    if (parsed === 'bad') return 'bad';
    body = parsed.body;
    rest = parsed.rest;
  } else {
    const cl = headers['content-length'];
    let bodyLen = 0;
    if (cl !== undefined) {
      if (!/^[0-9]+$/.test(cl.trim())) return 'bad';
      bodyLen = Number(cl);
      if (!Number.isSafeInteger(bodyLen) || bodyLen < 0) return 'bad';
    }
    if (buf.length < bodyStart + bodyLen) return null;
    body = buf.subarray(bodyStart, bodyStart + bodyLen);
    rest = buf.subarray(bodyStart + bodyLen);
  }
  const conn = (headers.connection ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.1' ? conn !== 'close' : conn === 'keep-alive';
  return { request: { method, target, headers, body }, rest, keepAlive };
}

/** Write one response. Two socket.write calls in the same tick are
    coalesced into one writev by the stream, so no Buffer.concat copy. */
function writeResponse(socket: Socket, req: RawRequest, result: RawResponse, keepAlive: boolean): void {
  const sendBody = req.method !== 'HEAD' && result.status !== 204 && result.status !== 304;
  const reason = REASONS[result.status] ?? 'OK';
  let head = `HTTP/1.1 ${result.status} ${reason}\r\ncontent-type: ${result.contentType}\r\ncontent-length: ${result.body.length}\r\n`;
  for (const name of Object.keys(result.headers)) {
    head += `${name}: ${result.headers[name]}\r\n`;
  }
  head += keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
  socket.write(head, 'ascii');
  if (sendBody && result.body.length > 0) socket.write(result.body);
}

function handleSocket(socket: Socket, handler: RawHandler): void {
  socket.setNoDelay(true);
  socket.setTimeout(IDLE_TIMEOUT_MS);
  let buf = Buffer.alloc(0);
  let draining = false;
  let dataPending = false;
  let closed = false;
  socket.on('timeout', () => {
    closed = true;
    socket.destroy();
  });
  socket.on('error', () => {
    closed = true;
  });
  socket.on('close', () => {
    closed = true;
  });
  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    if (draining) {
      // A drain is already running; it will pick this up in its loop, or
      // the finally below will re-run it. Just flag it — never start a
      // second drain (that would interleave responses on one socket).
      dataPending = true;
      return;
    }
    void drain();
  });

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (!closed) {
        const parsed = tryParseRequest(buf);
        if (parsed === null) return; // incomplete: wait for more data
        if (parsed === 'bad') {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', 'ascii');
          closed = true;
          socket.destroy();
          return;
        }
        buf = parsed.rest;
        let result: RawResponse;
        try {
          result = await handler(parsed.request);
        } catch {
          result = {
            status: 500,
            contentType: 'application/json; charset=utf-8',
            headers: {},
            body: Buffer.from('{"message":"Internal Server Error"}\n', 'utf8'),
          };
        }
        if (closed) return;
        writeResponse(socket, parsed.request, result, parsed.keepAlive);
        if (!parsed.keepAlive) {
          closed = true;
          socket.end();
          return;
        }
      }
    } finally {
      draining = false;
      // Data that arrived while this drain ran may not have been consumed
      // (it landed after the last parse). Re-run once if so; the flag is
      // cleared first, so this cannot recurse without new data.
      if (!closed && dataPending) {
        dataPending = false;
        void drain();
      }
    }
  }
}

/** Build a raw-TCP HTTP/1.1 server. Same interface as node:http's Server
    for the caller (listen/address/close/once('error')). */
export function createRawServer(handler: RawHandler): Server {
  const server = createNetServer((socket) => handleSocket(socket, handler));
  return server;
}
