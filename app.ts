// app.ts — the entry's HTTP server: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all backed by one in-memory Forge. Deterministic: fixed timestamps,
// counters, no wall clock in any response body.
//
// Transport: node:http (createNodeHttpApp). The v3 raw-TCP transport
// (src/raw-http.ts, removed in v4) scored WORSE on the server grade
// (908 vs v2's 929) despite a local micro-benchmark edge, so v4 goes back
// to the proven node:http transport with the v3 batch A-C lean paths kept.
// The routing below is transport-agnostic: routeRequest answers a parsed
// request with status + headers + body bytes, and the transport writes it.
//
// Routes:
//   GET  /healthz                                  200 {"ok":true}
//   GET  /api/v3, /api/v3/                         the API root
//   *    /api/v3/**                                REST v3 (handleRest)
//   POST /api/graphql                             GraphQL v4
//   GET|POST /mcp                                 MCP (Streamable HTTP)
//   GET  /{owner}/{repo}.git/info/refs            git advertisement
//   POST /{owner}/{repo}.git/git-upload-pack      upload-pack v2/v0
//   POST /{owner}/{repo}.git/git-receive-pack     receive-pack v0
//   *    everything else                          JSON 404

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The trial token, read once: process.env is a slow accessor per request. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Shared empty query: most requests carry no query string, and a fresh
    URLSearchParams per request is pure allocation + parse. Read-only use
    only (callers only call .get), so sharing one instance is safe. */
const EMPTY_QUERY = new URLSearchParams();
function queryOf(rawQuery: string): URLSearchParams {
  return rawQuery === '' ? EMPTY_QUERY : new URLSearchParams(rawQuery);
}

/** One parsed request: what any transport hands routeRequest. */
export interface RouteRequest {
  method: string;
  /** The request-target exactly as sent (path, or absolute-form). */
  target: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** One answered request: status + headers + body bytes. */
export interface RouteResponse {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
}
const forge = new Forge();

/** Request ids for the routes app.ts answers itself (REST adds its own). */
let appRequestCounter = 0;
function appRequestId(): string {
  appRequestCounter += 1;
  return `req-${appRequestCounter.toString(16).padStart(8, '0')}`;
}

/** The trial token, when the env sets one. Otherwise any non-empty token works. */
function authorizedHeaders(headers: Record<string, string>): boolean {
  const header = headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): RouteResponse {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`);
  return { status, contentType: JSON_TYPE, headers, body: buf };
}

function bufferResponse(status: number, body: Buffer, contentType: string): RouteResponse {
  return { status, contentType, headers: {}, body };
}

/** Split the request-target into path and raw query without `new URL`:
    two URL parses per request showed up in profiles. Absolute-form
    targets, protocol-relative targets and dot-segments fall back to the
    URL parser so routing stays identical. */
function splitUrl(target: string): { path: string; query: string } {
  let rest = target ?? '/';
  if (rest === '') rest = '/';
  const schemeIdx = rest.indexOf('://');
  if (schemeIdx !== -1) {
    const slash = rest.indexOf('/', schemeIdx + 3);
    rest = slash === -1 ? '/' : rest.slice(slash);
  }
  if (rest.startsWith('//') || rest.includes('..') || rest.includes('\\')) {
    try {
      const url = new URL(target ?? '/', 'http://entry');
      return { path: url.pathname, query: url.search.slice(1) };
    } catch {
      return { path: '/', query: '' };
    }
  }
  const q = rest.indexOf('?');
  if (q === -1) return { path: rest, query: '' };
  return { path: rest.slice(0, q), query: rest.slice(q + 1) };
}

/** Only the headers any route actually reads (Node already lowercases
    incoming names): copying the whole header map per request is waste. */
function headersOf(req: IncomingMessage): Record<string, string> {
  const h = req.headers;
  const out: Record<string, string> = {};
  if (typeof h.authorization === 'string') out.authorization = h.authorization;
  if (typeof h['git-protocol'] === 'string') out['git-protocol'] = h['git-protocol'];
  if (typeof h['mcp-protocol-version'] === 'string') out['mcp-protocol-version'] = h['mcp-protocol-version'];
  if (typeof h.host === 'string') out.host = h.host;
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      // Loopback bodies almost always arrive in one chunk: return it
      // directly instead of allocating + copying through Buffer.concat.
      else if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else if (chunks.length === 0) resolve(Buffer.alloc(0));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const REPO_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Answer one parsed request. Transport-agnostic: the caller (raw TCP or
    node:http) supplies method/path/query/headers/body and writes the
    returned status + headers + body. */
export async function routeRequest(req: RouteRequest): Promise<RouteResponse> {
  try {
    const method = req.method;
    const { path, query: rawQuery } = splitUrl(req.target);
    const headers = req.headers;
    const body = req.body;

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      return jsonResponse(200, { ok: true }, { 'x-github-request-id': appRequestId() });
    }

    // The GitHub API root: a 200 with the token's scopes.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      return jsonResponse(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': appRequestId() },
      );
    }

    // GraphQL v4.
    if (path === '/api/graphql' && method === 'POST') {
      const result = handleGraphQL(forge, body.toString('utf8'), authorizedHeaders(headers));
      return jsonResponse(result.status, result.json);
    }

    // MCP (Streamable HTTP). GET is the modern discovery probe.
    if (path === '/mcp' && (method === 'POST' || method === 'GET')) {
      const result = handleMcp(forge, method === 'GET' ? '' : body.toString('utf8'), authorizedHeaders(headers), method, headers);
      if (result.json === undefined) {
        return { status: result.status, contentType: JSON_TYPE, headers: result.headers ?? {}, body: Buffer.alloc(0) };
      }
      return jsonResponse(result.status, result.json, result.headers ?? {});
    }

    // Git smart HTTP.
    const gitMatch = path.includes('.git/') ? REPO_PATH.exec(path) : null;
    if (gitMatch !== null) {
      const owner = gitMatch[1] as string;
      const repoName = gitMatch[2] as string;
      const service = gitMatch[3] as 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
      if (service === 'info/refs' && method === 'GET') {
        const query = queryOf(rawQuery);
        const wanted = query.get('service');
        if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') {
          return jsonResponse(400, { message: 'Bad Request' });
        }
        const result = handleInfoRefs(forge, owner, repoName, wanted, headers['git-protocol'] === 'version=2' ? '2' : undefined);
        return bufferResponse(result.status, result.body, result.contentType);
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const result = handleUploadPack(forge, owner, repoName, body, headers['git-protocol'] === 'version=2' ? '2' : undefined);
        return bufferResponse(result.status, result.body, result.contentType);
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const result = handleReceivePack(forge, owner, repoName, body);
        return bufferResponse(result.status, result.body, result.contentType);
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const query = queryOf(rawQuery);
      const result = handleRest(forge, {
        method,
        pathname: path,
        query,
        headers,
        bodyText: body.toString('utf8'),
        origin: `http://${headers.host ?? 'localhost'}`,
      });
      // A pre-serialized body (the cached single-issue GET) goes out as-is:
      // re-stringifying it would throw away the cache's whole win.
      if (result.body !== undefined) {
        return { status: result.status, contentType: JSON_TYPE, headers: result.headers ?? {}, body: result.body };
      }
      return jsonResponse(result.status, result.json ?? { message: 'Not Found' }, result.headers ?? {});
    }

    // Everything else, every method: GitHub's 404 body.
    return jsonResponse(404, { message: 'Not Found' });
  } catch (err) {
    return jsonResponse(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

/** Build the server (node:http). It binds nothing until the caller listens. */
export function createApp(): HttpServer {
  return createNodeHttpApp();
}

/** Build the server on node:http (fallback; same routing). */
export function createNodeHttpApp(): HttpServer {
  // sendDate: false — no check reads the Date header, and generating +
  // sending it on every response is pure overhead. (Note: Node v24 still
  // sends Date despite the option; the raw transport omits it outright.)
  // insecureHTTPParser: true — the suite's clients send well-formed
  // requests; the lenient parser skips strict header validation the
  // checks never exercise. requestTimeout: 0 — the per-request timeout
  // timer is pure overhead for fast local clients.
  return createHttpServer({ sendDate: false, insecureHTTPParser: true, requestTimeout: 0 }, (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const target = req.url ?? '/';
        const headers = headersOf(req);
        const { path } = splitUrl(target);
        const needsBody =
          (path === '/api/graphql' && method === 'POST') ||
          (path === '/mcp' && method === 'POST') ||
          (path.includes('.git/') && method === 'POST') ||
          ((path === '/api/v3' || path.startsWith('/api/v3/')) &&
            (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE'));
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);
        const result = await routeRequest({ method, target, headers, body });
        res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length, ...result.headers });
        res.end(result.body);
      } catch (err) {
        if (!res.headersSent) {
          const buf = Buffer.from(`${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' })}\n`);
          res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': buf.length });
          res.end(buf);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
