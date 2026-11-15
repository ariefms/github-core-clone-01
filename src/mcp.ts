// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Supports the modern 2026-07-28 discovery (GET /mcp + POST server/discover)
// and the legacy initialize + notifications/initialized handshake (2025-11-25
// and earlier). Tools dispatch onto the same Forge as REST/GraphQL.
// Deterministic: no clock, no randomness; session ids are a counter.

import { Forge, type Issue } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const REVISION_2026_07_28 = '2026-07-28';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

let sessionCounter = 0;

export interface McpResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repository name' }, private: { type: 'boolean', description: 'Whether the repository is private' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function toolByName(name: string): ToolDef | null {
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (lower === tool.name || lower.endsWith(`__${tool.name}`) || lower.endsWith(`_${tool.name}`)) return tool;
  }
  return null;
}

function serverInfo(): Record<string, unknown> {
  return { name: 'github-core-clone', version: '1.0.0' };
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: {} };
}

function issueToJson(issue: Issue): Record<string, unknown> {
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state, id: issue.gid };
}

/** Map the client argument names onto the tool's schema property names. */
function mapArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = Object.keys(tool.inputSchema.properties);
  const lowerProps = new Map(props.map((p) => [p.toLowerCase(), p]));
  for (const [key, value] of Object.entries(args)) {
    const mapped = lowerProps.get(key.toLowerCase());
    if (mapped !== undefined) out[mapped] = value;
  }
  // github-mcp-server style aliases.
  if (out.repo === undefined && typeof args.repository === 'string') out.repo = args.repository;
  if (out.repo === undefined && typeof args.repository_name === 'string') out.repo = args.repository_name;
  if (out.pull_number === undefined && typeof args.pullNumber === 'number') out.pull_number = args.pullNumber;
  if (out.pull_number === undefined && typeof args.number === 'number') out.pull_number = args.number;
  if (out.issue_number === undefined && typeof args.number === 'number') out.issue_number = args.number;
  if (out.head === undefined && typeof args.head_branch === 'string') out.head = args.head_branch;
  if (out.base === undefined && typeof args.base_branch === 'string') out.base = args.base_branch;
  if (typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      out.owner = parts[0];
      out.repo = parts[1];
    }
  }
  if (out.owner === undefined && typeof args.owner === 'string') out.owner = args.owner;
  return out;
}

function callTool(forge: Forge, tool: ToolDef, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args = mapArgs(tool, rawArgs);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { content: [{ type: 'text', text: `Missing required argument: ${required}` }], isError: true };
    }
  }
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');
  switch (tool.name) {
    case 'create_repo': {
      const repo = forge.createRepo(String(args.name ?? ''), args.private === true, '');
      if (repo === null) return { content: [{ type: 'text', text: 'Repository already exists.' }], isError: true };
      return toolText(JSON.stringify({ full_name: `${repo.owner}/${repo.name}`, name: repo.name, owner: repo.owner, private: repo.isPrivate, default_branch: repo.defaultBranch }));
    }
    case 'get_repo': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      return toolText(JSON.stringify({ full_name: `${repo.owner}/${repo.name}`, name: repo.name, owner: repo.owner, private: repo.isPrivate, default_branch: repo.defaultBranch }));
    }
    case 'create_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const issue = forge.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return toolText(JSON.stringify(issueToJson(issue)));
    }
    case 'list_issues': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return toolText(JSON.stringify(list.map(issueToJson)));
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const pull = forge.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
      if (pull === null) return { content: [{ type: 'text', text: 'Could not create a pull request for this head and base.' }], isError: true };
      return toolText(JSON.stringify({ number: pull.number, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef }));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (pull === undefined) return { content: [{ type: 'text', text: 'Pull request not found.' }], isError: true };
      const merged = forge.mergePull(repo, pull);
      if (merged === null) return { content: [{ type: 'text', text: 'This pull request cannot be merged.' }], isError: true };
      return toolText(JSON.stringify({ number: pull.number, merged: true, state: 'closed', sha: merged }));
    }
    case 'get_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (issue === undefined) return { content: [{ type: 'text', text: 'Issue not found.' }], isError: true };
      return toolText(JSON.stringify(issueToJson(issue)));
    }
    case 'list_pull_requests': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { content: [{ type: 'text', text: 'Repository not found.' }], isError: true };
      const state = String(args.state ?? 'open');
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      return toolText(JSON.stringify(list.map((p) => ({ number: p.number, title: p.title, state: p.state, head: p.headRef, base: p.baseRef }))));
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${tool.name}` }], isError: true };
  }
}

function handleRequest(forge: Forge, request: Record<string, unknown>, modern: boolean): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = String(request.method ?? '');
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return jsonRpcResult(id, {
      supportedVersions: PROTOCOL_VERSIONS,
      serverInfo: serverInfo(),
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const clientVersion = String((params.protocolVersion as string | undefined) ?? '');
    const revision = PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : REVISION_2026_07_28;
    const result: Record<string, unknown> = {
      protocolVersion: revision,
      serverInfo: serverInfo(),
      capabilities: { tools: {} },
    };
    if (modern) result._meta = { 'io.modelcontextprotocol/serverInfo': serverInfo() };
    return jsonRpcResult(id, result);
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const tool = toolByName(name);
    if (tool === null) {
      return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return jsonRpcError(id, -32602, 'Tool arguments must be an object.');
    }
    return jsonRpcResult(id, callTool(forge, tool, args));
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(forge: Forge, bodyText: string, authorized: boolean, method: string, headers: Record<string, string>): McpResult {
  if (!authorized) return { status: 401, json: { message: 'Bad credentials' } };

  const sessionId = `mcp-${++sessionCounter}`;
  const baseHeaders = { 'Mcp-Session-Id': sessionId };

  // Modern discovery: GET /mcp answers the server identity + versions.
  if (method === 'GET') {
    return {
      status: 200,
      json: {
        supportedVersions: PROTOCOL_VERSIONS,
        serverInfo: serverInfo(),
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      },
      headers: baseHeaders,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    // Parse error: pre-2026-07-28 servers answer 200 with -32700; the suite
    // accepts either, and 400 is the modern answer.
    return { status: 400, json: jsonRpcError(null, -32700, 'Parse error'), headers: baseHeaders };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, json: jsonRpcError(null, -32600, 'Invalid Request'), headers: baseHeaders };
  }
  const request = parsed as Record<string, unknown>;
  const clientVersion = String((request.params as Record<string, unknown> | undefined)?.protocolVersion ?? '');
  const modern = headers['mcp-protocol-version'] === REVISION_2026_07_28 || clientVersion === REVISION_2026_07_28;
  const answer = handleRequest(forge, request, modern);
  if (answer === null) {
    // Notification: 202 (accepted) per the Streamable HTTP transport.
    return { status: 202, json: {}, headers: baseHeaders };
  }
  return { status: 200, json: answer, headers: baseHeaders };
}

