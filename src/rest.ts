// rest.ts — the GitHub REST v3 surface. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are {"message": ...}. No bearer token (or a token
// that is not the trial's) is a 401. Deterministic: fixed timestamps, counters.

import { FIXED_ISO, Forge, b64decode, isHex40, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

export interface RestResult {
  status: number;
  json?: unknown;
  /** A pre-serialized JSON body (the cached single-issue GET): when set,
   * app.ts sends these bytes as-is instead of stringifying `json`. */
  body?: Buffer;
  headers?: Record<string, string>;
}

export interface RestContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  bodyText: string;
  origin: string;
}

let requestCounter = 0;

/**
 * Serialized single-issue GET bodies, keyed `${repo.dbId}:${issue.number}`.
 * The read workload GETs the same issue 2,000 times in a row with no write
 * in between, so caching the serialized bytes skips the per-request
 * issueJson object build + JSON.stringify + Buffer.from. Invalidation is
 * exact: PATCH is the only mutation of an issue's title/body/state, so it
 * drops that issue's entry; DELETE repo drops the repo's entries. Creating
 * an issue or a comment does not change any existing issue's JSON (the issue
 * shape carries no comment count), so no invalidation is needed there. The
 * X-GitHub-Request-Id header is still generated fresh per request by
 * handleRest — only the body bytes are cached.
 */
const issueBodyCache = new Map<string, Buffer>();

function issueCacheKey(repo: Repo, number: number): string {
  return `${repo.dbId}:${number}`;
}

function invalidateIssue(repo: Repo, number: number): void {
  issueBodyCache.delete(issueCacheKey(repo, number));
}

function invalidateRepoIssues(repo: Repo): void {
  const prefix = `${repo.dbId}:`;
  for (const key of issueBodyCache.keys()) {
    if (key.startsWith(prefix)) issueBodyCache.delete(key);
  }
}

/** The trial token, read once: process.env is a slow accessor per request. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function ok(status: number, json: unknown, headers?: Record<string, string>): RestResult {
  return { status, json, headers };
}

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function authorized(ctx: RestContext): boolean {
  const header = ctx.headers.authorization ?? ctx.headers.Authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function parseBody(ctx: RestContext): { value: unknown; bad: boolean } {
  if (ctx.bodyText === '') return { value: undefined, bad: false };
  try {
    return { value: JSON.parse(ctx.bodyText) as unknown, bad: false };
  } catch {
    return { value: undefined, bad: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; perPage: number; pageNum: number } {
  const perPage = Math.min(100, intParam(query, 'per_page', 30));
  const pageNum = intParam(query, 'page', 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNum };
}

function linkHeader(ctx: RestContext, total: number, perPage: number, pageNum: number): string | null {
  if (pageNum * perPage >= total) return null;
  const url = `${ctx.origin}${ctx.pathname}?per_page=${perPage}&page=${pageNum + 1}`;
  return `<${url}>; rel="next"`;
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: FIXED_ISO };
  const epoch = Number(match[3]);
  const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : FIXED_ISO;
  return { name: match[1] ?? '', email: match[2] ?? '', date };
}

// ---------------------------------------------------------------- router

export function handleRest(forge: Forge, ctx: RestContext): RestResult {
  const result = routeRest(forge, ctx);
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...(result.headers ?? {}) };
  return { ...result, headers };
}

/** Split a pathname into non-empty segments, decoding % escapes only in
    segments that contain one — the old split('/').filter().map() built
    three intermediate arrays per request. Behavior identical: a bad %
    escape still throws (callers turn it into a 500, as before). */
function splitSegments(pathname: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname.charCodeAt(i) === 47 /* '/' */) {
      if (i > start) {
        let segment = pathname.slice(start, i);
        if (segment.includes('%')) segment = decodeURIComponent(segment);
        segments.push(segment);
      }
      start = i + 1;
    }
  }
  return segments;
}

function routeRest(forge: Forge, ctx: RestContext): RestResult {
  const { method } = ctx;
  // The path arrives as /api/v3/...; strip the prefix, keep the full path for links.
  const all = splitSegments(ctx.pathname);
  const segments = all[0] === 'api' && all[1] === 'v3' ? all.slice(2) : all;
  if (!authorized(ctx)) return err(401, 'Bad credentials');
  const { value: body, bad } = parseBody(ctx);
  if (bad) return err(400, 'Problems parsing JSON');

  // GET /api/v3/ (root) and /meta and /user
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {}, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createUserRepo(forge, body);
    if (method === 'GET') {
      const { page, total, perPage, pageNum } = paginate(forge.repos, ctx.query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx, total, perPage, pageNum);
      if (link !== null) headers.link = link;
      return ok(200, page.map(repoJson), headers);
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos') return routeRepo(forge, ctx, segments, body);
  return err(404, 'Not Found');
}

function createUserRepo(forge: Forge, body: unknown): RestResult {
  if (!isRecord(body)) return err(422, 'Validation Failed');
  const name = str(body.name);
  if (name === '') return err(422, 'Validation Failed: name is required');
  const repo = forge.createRepo(name, bool(body.private, false), str(body.description));
  if (repo === null) return err(422, `Repository ${name} already exists`);
  return ok(201, repoJson(repo));
}

function routeRepo(forge: Forge, ctx: RestContext, segments: string[], body: unknown): RestResult {
  const { method } = ctx;
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  if (owner === '' || name === '') return err(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (repo === null) return err(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      invalidateRepoIssues(repo);
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
      return ok(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: rest[1], commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return err(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === null) return err(404, 'Not Found');
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = forge.commitOf(repo, oid);
      if (commit === null) continue;
      commits.push({
        sha: oid,
        commit: {
          message: commit.message,
          author: identJson(commit.author),
          committer: identJson(commit.committer),
        },
      });
      for (const parent of commit.parents) stack.push(parent);
    }
    return ok(200, commits);
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === '' || !isHex40(sha)) return err(422, 'Validation Failed');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'contents') return routeContents(forge, ctx, repo, rest.slice(1), body);
  if (rest[0] === 'labels') return routeLabels(forge, ctx, repo, body);
  if (rest[0] === 'issues') return routeIssues(forge, ctx, repo, rest.slice(1), body);
  if (rest[0] === 'pulls') return routePulls(forge, ctx, repo, rest.slice(1), body);
  return err(404, 'Not Found');
}

function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  if (isHex40(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------- contents

function routeContents(forge: Forge, ctx: RestContext, repo: Repo, pathSegments: string[], body: unknown): RestResult {
  const { method } = ctx;
  const path = pathSegments.join('/');
  if (path === '') return err(404, 'Not Found');
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === null) return err(404, 'Not Found');
    const commit = forge.commitOf(repo, tip);
    if (commit === null) return err(404, 'Not Found');
    const flat = forge.flattenTree(repo, commit.tree);
    const file = flat.get(path);
    if (file !== undefined) {
      const object = repo.objects.get(file.oid);
      if (object === undefined) return err(404, 'Not Found');
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: file.oid,
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    // A directory: direct children.
    const children: Record<string, unknown>[] = [];
    const prefix = `${path}/`;
    const seenDirs = new Set<string>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.push({ type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const dirTree = treeOidAt(forge, repo, commit.tree, `${path}/${dir}`);
        children.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirTree ?? '' });
      }
    }
    if (children.length === 0) return err(404, 'Not Found');
    children.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return ok(200, children);
  }
  if (method === 'PUT') {
    if (!isRecord(body)) return err(422, 'Validation Failed');
    const message = str(body.message);
    const contentB64 = str(body.content);
    const branch = str(body.branch) || repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    let contentBytes: Buffer;
    try {
      contentBytes = b64decode(contentB64);
    } catch {
      return err(422, 'Validation Failed: content is not base64');
    }
    if (message === '' || contentB64 === '') return err(422, 'Validation Failed');
    // Resolve the branch, creating it from the default tip when it is new.
    let tip = forge.tipOf(repo, branch);
    if (tip === null) {
      if (branch === repo.defaultBranch) {
        tip = null; // unborn: the first commit
      } else {
        const defaultTip = forge.tipOf(repo, repo.defaultBranch);
        if (defaultTip === null) return err(422, 'Validation Failed: cannot create a branch with no base commit');
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const tipCommit = tip === null ? null : forge.commitOf(repo, tip);
    const flat = forge.flattenTree(repo, tipCommit?.tree ?? null);
    const current = flat.get(path);
    if (sha !== undefined) {
      if (current === undefined || current.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
    } else if (current !== undefined) {
      return err(422, 'Validation Failed: file already exists');
    }
    const blobOid = forge.putObject(repo, 'blob', contentBytes);
    const next = new Map<string, string>();
    for (const [p, entry] of flat) next.set(p, entry.oid);
    next.set(path, blobOid);
    const treeOid = forge.buildTreeFromMap(repo, next);
    const parents = tip === null ? [] : [tip];
    const commitSha = forge.makeCommit(repo, branch, treeOid, parents, message);
    const status = current !== undefined || sha !== undefined ? 200 : 201;
    return ok(status, {
      content: { sha: blobOid, encoding: 'base64', name: path.split('/').pop() ?? path, path, size: contentBytes.length },
      commit: { sha: commitSha },
    });
  }
  if (method === 'DELETE') {
    if (!isRecord(body)) return err(422, 'Validation Failed');
    const message = str(body.message);
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = forge.tipOf(repo, repo.defaultBranch);
    if (tip === null) return err(404, 'Not Found');
    const tipCommit = forge.commitOf(repo, tip);
    if (tipCommit === null) return err(404, 'Not Found');
    const flat = forge.flattenTree(repo, tipCommit.tree);
    const current = flat.get(path);
    if (current === undefined) return err(404, 'Not Found');
    if (sha !== undefined && current.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
    const next = new Map<string, string>();
    for (const [p, entry] of flat) if (p !== path) next.set(p, entry.oid);
    const treeOid = forge.buildTreeFromMap(repo, next);
    const commitSha = forge.makeCommit(repo, repo.defaultBranch, treeOid, [tip], message === '' ? 'delete file' : message);
    return ok(200, { commit: { sha: commitSha } });
  }
  return err(404, 'Not Found');
}

function treeOidAt(forge: Forge, repo: Repo, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const entries = forge.treeOf(repo, current);
    if (entries === null) return null;
    const entry = entries.find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- labels

function routeLabels(forge: Forge, ctx: RestContext, repo: Repo, body: unknown): RestResult {
  if (ctx.method === 'GET') {
    return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
  }
  if (ctx.method === 'POST') {
    if (!isRecord(body)) return err(422, 'Validation Failed');
    const name = str(body.name);
    if (name === '') return err(422, 'Validation Failed: name is required');
    const color = str(body.color) || 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) return ok(200, { name: existing.name, color: existing.color });
    repo.labels.set(name, { name, color });
    return ok(201, { name, color });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function routeIssues(forge: Forge, ctx: RestContext, repo: Repo, rest: string[], body: unknown): RestResult {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const title = str(body.title);
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const labels: { name: string; color: string }[] = [];
      for (const labelName of labelNames) {
        const label = repo.labels.get(labelName);
        if (label === undefined) return err(422, `Validation Failed: label ${labelName} does not exist`);
        labels.push(label);
      }
      const issue = forge.createIssue(repo, title, str(body.body), labels);
      return ok(201, issueJson(issue));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, total, perPage, pageNum } = paginate(list, ctx.query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx, total, perPage, pageNum);
      if (link !== null) headers.link = link;
      return ok(200, page.map(issueJson), headers);
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = forge.getIssue(repo, number);
  if (issue === null) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') {
      const key = issueCacheKey(repo, issue.number);
      const cached = issueBodyCache.get(key);
      if (cached !== undefined) return { status: 200, body: cached };
      // Byte-identical to what jsonResponse would send: the JSON plus the
      // trailing newline, so a cached reply is indistinguishable from a
      // freshly built one.
      const body = Buffer.from(`${JSON.stringify(issueJson(issue))}\n`, 'utf8');
      issueBodyCache.set(key, body);
      return { status: 200, body };
    }
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      invalidateIssue(repo, issue.number);
      return ok(200, issueJson(issue));
    }
    return err(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const commentBody = str(body.body);
      if (commentBody === '') return err(422, 'Validation Failed: body is required');
      const comment = forge.createComment(repo, issue, commentBody);
      return ok(201, { id: comment.id, node_id: comment.gid, body: comment.body, created_at: FIXED_ISO });
    }
    if (method === 'GET') {
      return ok(200, issue.comments.map((c) => ({ id: c.id, node_id: c.gid, body: c.body, created_at: FIXED_ISO })));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function routePulls(forge: Forge, ctx: RestContext, repo: Repo, rest: string[], body: unknown): RestResult {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base) || repo.defaultBranch;
      if (title === '' || head === '') return err(422, 'Validation Failed');
      if (forge.tipOf(repo, head) === null || forge.tipOf(repo, base) === null) {
        return err(422, 'Validation Failed: head or base branch does not exist');
      }
      const pull = forge.createPull(repo, title, str(body.body), head, base);
      if (pull === null) return err(422, 'Validation Failed: a pull request is already open for this head and base');
      return ok(201, pullJson(pull, repo));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.seq - b.seq);
      const { page, total, perPage, pageNum } = paginate(list, ctx.query);
      const headers: Record<string, string> = {};
      const link = linkHeader(ctx, total, perPage, pageNum);
      if (link !== null) headers.link = link;
      return ok(200, page.map((p) => pullJson(p, repo)), headers);
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = forge.getPull(repo, number);
  if (pull === null) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(pull, repo));
    return err(404, 'Not Found');
  }
  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    return ok(200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
  }
  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    if (pull.state !== 'open') return err(405, 'Pull request is already closed');
    const mergeSha = forge.mergePull(repo, pull);
    if (mergeSha === null) return err(405, 'Merge conflict');
    return ok(200, { sha: mergeSha, merged: true, message: `Merge pull request #${pull.number}` });
  }
  return err(404, 'Not Found');
}
