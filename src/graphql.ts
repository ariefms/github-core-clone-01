// graphql.ts — a small GraphQL v4 executor for exactly the documents gh and
// github-mcp-server send: viewer, repository (+issues/pullRequests/node),
// __type probes, and the create/close/merge/comment mutations. Unknown fields
// are HTTP 200 with an errors array naming the field. No auth is a 401.
// Deterministic: global ids are base64 of stable parts, no clock.

import { Forge, decodeGlobalId, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------- parser

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string }[];
  selections: Selection[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== null && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== null && next.kind === 'name') name = this.next().value as string;
        const varDefs: { name: string }[] = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            varDefs.push({ name: this.expectName() });
            this.expectPunct(':');
            this.parseType();
            if (this.acceptPunct('=')) this.parseValue();
          }
        }
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.expectName();
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return operations;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    if (this.acceptPunct('...')) {
      const next = this.peek();
      if (next !== null && next.kind === 'name' && next.value === 'on') {
        this.next();
        const fragmentType = this.expectName();
        return { alias: null, name: '', args: {}, selections: this.parseSelectionSet(), fragmentType };
      }
      throw new Error('named fragment spreads are not supported');
    }
    let alias: string | null = null;
    let name = this.expectName();
    const next = this.peek();
    if (next !== null && next.kind === 'punct' && next.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Directives (none used): skip @name(args).
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    const peeked = this.peek();
    const selections = peeked !== null && peeked.kind === 'punct' && peeked.value === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek() !== null && this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek() !== null && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
  User: ['id', 'login', 'name', 'email'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'LABEL', 'MILESTONE'];

// ---------------------------------------------------------------- executor

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string; path: (string | number)[] }[];
}

type Value = Record<string, unknown> | null;

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __issue: issue };
}

function pullObject(pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', __pull: pull };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function userObject(login: string): Record<string, unknown> {
  return { __typename: 'User', login };
}

function executeSelections(
  typeName: string,
  parent: Record<string, unknown>,
  selections: Selection[],
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      const actual = (parent.__typename as string | undefined) ?? typeName;
      if (actual === selection.fragmentType) {
        const inner = executeSelections(typeName, parent, selection.selections ?? [], ctx, path);
        Object.assign(out, inner);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(typeName, selection.name, parent, selection.args, selection.selections, ctx, [...path, key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function resolveField(
  typeName: string,
  field: string,
  parent: Record<string, unknown>,
  args: Record<string, GqlValue>,
  selections: Selection[] | null,
  ctx: Ctx,
  path: (string | number)[],
): unknown {
  const resolvedArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) resolvedArgs[key] = resolveValue(value, ctx.variables);

  if (typeName === 'Query') {
    if (field === 'viewer') {
      const value = userObject(VIEWER_LOGIN);
      return selections === null ? value : executeSelections('User', value, selections, ctx, path);
    }
    if (field === 'repository') {
      const repo = ctx.forge.getRepo(String(resolvedArgs.owner ?? ''), String(resolvedArgs.name ?? ''));
      if (repo === null) return null;
      const value = repoObject(repo);
      return selections === null ? value : executeSelections('Repository', value, selections, ctx, path);
    }
    if (field === 'node') {
      const decoded = decodeGlobalId(String(resolvedArgs.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const repo = ctx.forge.getRepoByGid(String(resolvedArgs.id ?? ''));
        if (repo === null) return null;
        const value = repoObject(repo);
        return selections === null ? value : executeSelections('Repository', value, selections, ctx, path);
      }
      return null;
    }
    if (field === '__type') {
      const name = String(resolvedArgs.name ?? '');
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      const value: Record<string, unknown> = { __typename: '__Type', __typeName: name, __fields: fields };
      return selections === null ? value : executeSelections('__Type', value, selections, ctx, path);
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "Query".`, path });
    return undefined;
  }

  if (typeName === '__Type') {
    if (field === 'fields') {
      const names = (parent.__fields as string[]) ?? [];
      return names.map((n) => ({ name: n }));
    }
    if (field === 'enumValues') {
      if ((parent.__typeName as string) !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((n) => ({ name: n }));
    }
    if (field === 'name') return parent.__typeName as string;
    ctx.errors.push({ message: `Cannot query field "${field}" on type "__Type".`, path });
    return undefined;
  }

  if (typeName === 'User') {
    if (field === 'login') return parent.login as string;
    ctx.errors.push({ message: `Cannot query field "${field}" on type "User".`, path });
    return undefined;
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    switch (field) {
      case 'id':
        return repo.gid;
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner': {
        const value = userObject(repo.owner);
        return selections === null ? value : executeSelections('User', value, selections, ctx, path);
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(resolvedArgs.number));
        if (issue === undefined) return null;
        const value = issueObject(issue);
        return selections === null ? value : executeSelections('Issue', value, selections, ctx, path);
      }
      case 'issues':
        return issuesConnection(repo, resolvedArgs, selections, ctx, path);
      case 'pullRequests': {
        const first = typeof resolvedArgs.first === 'number' ? resolvedArgs.first : undefined;
        const open = repo.pulls.filter((p) => p.state === 'open');
        const list = first === undefined ? open : open.slice(0, first);
        const nodesSelection = (selections ?? []).find((s) => s.name === 'nodes');
        const nodes = list.map((p) => executeSelections('PullRequest', pullObject(p), nodesSelection?.selections ?? [], ctx, path));
        return { nodes };
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === Number(resolvedArgs.number));
        if (pull === undefined) return null;
        const value = pullObject(pull);
        return selections === null ? value : executeSelections('PullRequest', value, selections, ctx, path);
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field}" on type "Repository".`, path });
        return undefined;
    }
  }

  if (typeName === 'Issue') {
    const issue = parent.__issue as Issue;
    switch (field) {
      case 'id':
        return issue.gid;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      default:
        ctx.errors.push({ message: `Cannot query field "${field}" on type "Issue".`, path });
        return undefined;
    }
  }

  if (typeName === 'PullRequest') {
    const pull = parent.__pull as Pull;
    switch (field) {
      case 'id':
        return pull.gid;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        const repo = pullRepo(ctx.forge, pull);
        if (repo === null) return 'UNKNOWN';
        return ctx.forge.mergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'files': {
        const first = typeof resolvedArgs.first === 'number' ? resolvedArgs.first : undefined;
        const files = first === undefined ? pull.files : pull.files.slice(0, first);
        return { nodes: files.map((f) => ({ path: f.filename })) };
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field}" on type "PullRequest".`, path });
        return undefined;
    }
  }

  if (typeName === 'Mutation') {
    return resolveMutation(field, resolvedArgs, ctx, selections, path);
  }

  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".`, path });
  return undefined;
}

function pullRepo(forge: Forge, pull: Pull): Repo | null {
  return forge.repos.find((r) => r.pulls.includes(pull)) ?? null;
}

function issuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
  selections: Selection[] | null,
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(issueState(i)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : orderBy !== null ? 'desc' : 'asc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const after = typeof args.after === 'string' && args.after !== '' ? decodeCursor(args.after) : null;
  if (after !== null) {
    list = list.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  const out: Record<string, unknown> = {};
  for (const selection of selections ?? []) {
    const key = selection.alias ?? selection.name;
    if (selection.name === 'nodes') {
      out[key] = page.map((issue) => executeSelections('Issue', issueObject(issue), selection.selections ?? [], ctx, [...path, key]));
    } else if (selection.name === 'pageInfo') {
      const pageInfo: Record<string, unknown> = {};
      for (const sub of selection.selections ?? []) {
        if (sub.name === 'hasNextPage') pageInfo[sub.alias ?? sub.name] = hasNextPage;
        if (sub.name === 'endCursor') pageInfo[sub.alias ?? sub.name] = endCursor;
      }
      out[key] = pageInfo;
    } else if (selection.name === 'totalCount') {
      out[key] = list.length;
    }
  }
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveMutation(
  field: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selections: Selection[] | null,
  path: (string | number)[],
): unknown {
  const input = isRecord(args.input) ? args.input : {};
  if (field === 'createIssue') {
    const repo = ctx.forge.getRepoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
      return null;
    }
    const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    const value: Record<string, unknown> = { issue: { number: issue.number, id: issue.gid } };
    return selections === null ? value : shapePayload(value, selections, ctx, path);
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (decoded === null || decoded.kind !== 'I') {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    const repo = ctx.forge.repos.find((r) => r.dbId === Number(decoded.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    issue.state = 'closed';
    const value: Record<string, unknown> = { issue: { number: issue.number, id: issue.gid, state: 'CLOSED' } };
    return selections === null ? value : shapePayload(value, selections, ctx, path);
  }
  if (field === 'createPullRequest') {
    const repo = ctx.forge.getRepoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
      return null;
    }
    const pull = ctx.forge.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (pull === null) {
      ctx.errors.push({ message: 'Could not create a pull request for this head and base.', path });
      return null;
    }
    const value: Record<string, unknown> = {
      pullRequest: { number: pull.number, id: pull.gid, state: 'OPEN', headRefName: pull.headRef, baseRefName: pull.baseRef },
    };
    return selections === null ? value : shapePayload(value, selections, ctx, path);
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.kind !== 'P') {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path });
      return null;
    }
    const repo = ctx.forge.repos.find((r) => r.dbId === Number(decoded.parts[0]));
    const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path });
      return null;
    }
    const merged = ctx.forge.mergePull(repo, pull);
    if (merged === null) {
      ctx.errors.push({ message: 'This pull request cannot be merged.', path });
      return null;
    }
    const value: Record<string, unknown> = { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } };
    return selections === null ? value : shapePayload(value, selections, ctx, path);
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.kind !== 'I') {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    const repo = ctx.forge.repos.find((r) => r.dbId === Number(decoded.parts[0]));
    const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
      return null;
    }
    const comment = ctx.forge.createComment(repo, issue, String(input.body ?? ''));
    const value: Record<string, unknown> = { commentEdge: { node: { id: comment.gid, body: comment.body } } };
    return selections === null ? value : shapePayload(value, selections, ctx, path);
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "Mutation".`, path });
  return undefined;
}

/** Shape a mutation payload through its selections (plain objects, no type logic). */
function shapePayload(
  value: Record<string, unknown>,
  selections: Selection[],
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null) continue;
    const key = selection.alias ?? selection.name;
    const raw = value[selection.name];
    if (raw === undefined) continue;
    if (selection.selections !== null && isRecord(raw)) {
      out[key] = shapePayload(raw, selection.selections, ctx, [...path, key]);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

// ---------------------------------------------------------------- HTTP entry

export interface GraphQLResult {
  status: number;
  json: unknown;
}

function runOperation(forge: Forge, query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string; path: (string | number)[] }[] } {
  const ctx: Ctx = { forge, variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err), path: [] }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operations in the document.', path: [] }] };
  }
  const operation = operations[0] as Operation;
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, {}, operation.selections, ctx, []);
  return { data, errors: ctx.errors };
}

export function handleGraphQL(forge: Forge, bodyText: string, authorized: boolean): GraphQLResult {
  if (!authorized) return { status: 401, json: { message: 'Bad credentials' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, json: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const { data, errors } = runOperation(forge, entry.query, variables);
    const out: Record<string, unknown> = {};
    if (data !== null) out.data = data;
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map(runOne) };
  }
  return { status: 200, json: runOne(parsed) };
}

