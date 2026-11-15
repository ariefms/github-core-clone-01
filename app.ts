// app.ts — the entry's HTTP server: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all backed by one in-memory Forge. Deterministic: fixed timestamps,
// counters, no wall clock in any response body.
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** One Forge per process: the whole trial's state. */
const forge = new Forge();

/** Request ids for the routes app.ts answers itself (REST adds its own). */
let appRequestCounter = 0;
function appRequestId(): string {
  appRequestCounter += 1;
  return `req-${appRequestCounter.toString(16).padStart(8, '0')}`;
}

/** The trial token, when the env sets one. Otherwise any non-empty token works. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Split the request-target into path and raw query without `new URL`:
    two URL parses per request showed up in profiles. Absolute-form
    targets, protocol-relative targets and dot-segments fall back to the
    URL parser so routing stays identical. */
function splitUrl(req: IncomingMessage): { path: string; query: string } {
  let rest = req.url ?? '/';
  if (rest === '') rest = '/';
  const schemeIdx = rest.indexOf('://');
  if (schemeIdx !== -1) {
    const slash = rest.indexOf('/', schemeIdx + 3);
    rest = slash === -1 ? '/' : rest.slice(slash);
  }
  if (rest.startsWith('//') || rest.includes('..') || rest.includes('\\')) {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
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
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const REPO_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  // sendDate: false — no check reads the Date header, and generating +
  // sending it on every response is pure overhead.
  return createServer({ sendDate: false }, (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const { path, query: rawQuery } = splitUrl(req);
        const headers = headersOf(req);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, { 'x-github-request-id': appRequestId() });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(
            res,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': appRequestId() },
          );
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          const body = await readBody(req);
          const result = handleGraphQL(forge, body.toString('utf8'), authorized(req));
          sendJson(res, result.status, result.json);
          return;
        }

        // MCP (Streamable HTTP). GET is the modern discovery probe.
        if (path === '/mcp' && (method === 'POST' || method === 'GET')) {
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          const result = handleMcp(forge, body.toString('utf8'), authorized(req), method, headers);
          if (result.json === undefined) {
            res.writeHead(result.status, { ...result.headers });
            res.end();
          } else {
            sendJson(res, result.status, result.json, result.headers ?? {});
          }
          return;
        }

        // Git smart HTTP.
        const gitMatch = REPO_PATH.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const service = gitMatch[3] as 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
          if (service === 'info/refs' && method === 'GET') {
            const query = new URLSearchParams(rawQuery);
            const wanted = query.get('service');
            if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            const result = handleInfoRefs(forge, owner, repoName, wanted, headers['git-protocol'] === 'version=2' ? '2' : undefined);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = handleUploadPack(forge, owner, repoName, body, headers['git-protocol'] === 'version=2' ? '2' : undefined);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const result = handleReceivePack(forge, owner, repoName, body);
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const query = new URLSearchParams(rawQuery);
          const body = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
          const result = handleRest(forge, {
            method,
            pathname: path,
            query,
            headers,
            bodyText: body.toString('utf8'),
            origin: `http://${req.headers.host ?? 'localhost'}`,
          });
          sendJson(res, result.status, result.json ?? { message: 'Not Found' }, result.headers ?? {});
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
