// store.ts — the forge's whole state, in memory. One store serves REST, GraphQL,
// MCP and git smart HTTP, so every surface reads the same objects. Deterministic:
// commit timestamps come from a counter (never the wall clock), all other
// timestamps are one fixed ISO string, ids are counters.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './git-core.ts';
import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

export const FIXED_ISO = '2025-01-01T00:00:00Z';
const COMMIT_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z, plus a counter

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
export function b64decode(text: string): Buffer {
  return Buffer.from(text, 'base64');
}

export function repoGlobalId(dbId: number): string {
  return b64encode(`R:${dbId}`);
}
export function issueGlobalId(dbId: number, number: number): string {
  return b64encode(`I:${dbId}:${number}`);
}
export function pullGlobalId(dbId: number, number: number): string {
  return b64encode(`P:${dbId}:${number}`);
}
export function commentGlobalId(dbId: number, issueNumber: number, commentId: number): string {
  return b64encode(`C:${dbId}:${issueNumber}:${commentId}`);
}

/** Decode a global id back to its kind and parts, or null. */
export function decodeGlobalId(gid: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts[0];
    if (kind === undefined || !/^[RIPC]$/.test(kind)) return null;
    if (text !== `${kind}:${parts.slice(1).join(':')}`) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  gid: string;
  body: string;
}

export interface Issue {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  baseShaAtCreate: string;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  dbId: number;
  gid: string;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
  commitCache: Map<string, ReturnType<typeof parseCommit>>;
  treeCache: Map<string, TreeEntry[]>;
}

export class Forge {
  repos: Repo[] = [];
  private nextRepoDbId = 1;
  private nextRestId = 1;
  private commitSeq = 0;

  nextId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  // ---------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.some((r) => r.name === name)) return null;
    const dbId = this.nextRepoDbId;
    this.nextRepoDbId += 1;
    const repo: Repo = {
      dbId,
      gid: repoGlobalId(dbId),
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.repos.length,
      commitCache: new Map(),
      treeCache: new Map(),
    };
    this.repos.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.find((r) => r.name === name) ?? null;
  }

  getRepoByGid(gid: string): Repo | null {
    const decoded = decodeGlobalId(gid);
    if (decoded === null || decoded.kind !== 'R') return null;
    const dbId = Number(decoded.parts[0]);
    if (!Number.isInteger(dbId)) return null;
    return this.repos.find((r) => r.dbId === dbId) ?? null;
  }

  deleteRepo(repo: Repo): void {
    const index = this.repos.indexOf(repo);
    if (index >= 0) this.repos.splice(index, 1);
  }

  // ---------------------------------------------------------------- objects

  storeObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  commitOf(repo: Repo, oid: string): ReturnType<typeof parseCommit> | null {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  treeOf(repo: Repo, oid: string): TreeEntry[] | null {
    const cached = repo.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    repo.treeCache.set(oid, parsed);
    return parsed;
  }

  /**
   * The objects of the given commits plus their tree closures — but never a
   * commit's parents. This is what a depth-capped fetch sends: the included
   * commits are the boundary, their history stays behind.
   */
  collectCommitObjects(repo: Repo, commits: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [...commits];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const commit = this.commitOf(repo, oid);
        if (commit !== null) stack.push(commit.tree);
      } else if (object.type === 'tree') {
        const entries = this.treeOf(repo, oid);
        if (entries !== null) for (const entry of entries) stack.push(entry.oid);
      }
    }
    return out;
  }

  /** All objects reachable from the given tips (commits, tags, trees, blobs). */
  collectObjects(repo: Repo, tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const commit = this.commitOf(repo, oid);
        if (commit === null) continue;
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        const entries = this.treeOf(repo, oid);
        if (entries === null) continue;
        for (const entry of entries) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        // Tags point at their target; the target's closure follows.
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match !== null) stack.push(match[1] as string);
      }
    }
    return out;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(repo, oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  buildTreeFromMap(repo: Repo, files: Map<string, string>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build('');
  }

  /** A new commit's identity line; the timestamp is a deterministic counter. */
  private nextIdent(): string {
    this.commitSeq += 1;
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${COMMIT_EPOCH + this.commitSeq} +0000`;
  }

  /** Create a commit on a branch and move the branch to it. */
  makeCommit(
    repo: Repo,
    branch: string,
    treeOid: string,
    parents: readonly string[],
    message: string,
  ): string {
    const ident = this.nextIdent();
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  tipOf(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  // ---------------------------------------------------------------- fetch

  /**
   * The objects a fetch must send. Wants are commit (or tag) ids; haves are
   * commits the client already holds in full; shallow lists the client's
   * shallow boundaries (held as tips, ancestors not held); depth caps the
   * commit generations from the wants. Answers the objects plus the new
   * shallow-info lines.
   */
  fetchSelection(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallow: readonly string[],
    depth: number | undefined,
  ): { objects: Array<{ oid: string; object: GitObject }>; shallowOut: string[]; unshallowOut: string[] } {
    const shallowSet = new Set(shallow);
    // Held commits: the haves' full ancestry, cut at shallow boundaries.
    const held = new Set<string>();
    const heldStack = [...haves];
    while (heldStack.length > 0) {
      const oid = heldStack.pop() as string;
      if (held.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) heldStack.push(parent);
    }
    for (const oid of shallowSet) {
      if (this.commitOf(repo, oid) !== null) held.add(oid);
    }
    // Expand tag wants to their target commits; the tag objects travel too.
    const wantCommits: string[] = [];
    const extraObjects = new Set<string>();
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        extraObjects.add(want);
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match !== null) wantCommits.push(match[1] as string);
      } else if (object.type === 'commit') {
        wantCommits.push(want);
      }
    }
    // BFS from the wants with the depth cap. Index pointer instead of
    // queue.shift(): shift() is O(n) per dequeue on a long chain.
    const included = new Set<string>();
    const boundary = new Set<string>();
    const visited = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = wantCommits.map((oid) => ({ oid, d: 1 }));
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex] as { oid: string; d: number };
      queueIndex += 1;
      if (visited.has(current.oid)) continue;
      visited.add(current.oid);
      const commit = this.commitOf(repo, current.oid);
      if (commit === null) continue;
      if (held.has(current.oid)) {
        // A held shallow boundary still lets the walk descend to its parents.
        if (shallowSet.has(current.oid)) {
          for (const parent of commit.parents) queue.push({ oid: parent, d: current.d + 1 });
        }
        continue;
      }
      if (depth !== undefined && current.d > depth) continue;
      included.add(current.oid);
      if (depth !== undefined && current.d === depth) {
        boundary.add(current.oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, d: current.d + 1 });
    }
    const unshallow = new Set<string>();
    for (const oid of shallowSet) {
      const commit = this.commitOf(repo, oid);
      if (commit !== null && commit.parents.some((p) => included.has(p))) unshallow.add(oid);
    }
    // The wanted objects are the included commits plus their tree closures
    // only — never their parents (a depth cap would be meaningless otherwise).
    // Held objects are the same shape: `held` already holds exactly the
    // commits the client has (ancestry cut at shallow boundaries), so a full
    // closure here would wrongly subtract a shallow boundary's ancestors —
    // the very objects a deepen fetch must deliver.
    const wantObjs = this.collectCommitObjects(repo, included);
    const heldObjs = this.collectCommitObjects(repo, held);
    const send = new Set<string>();
    for (const oid of wantObjs) if (!heldObjs.has(oid)) send.add(oid);
    for (const oid of extraObjects) send.add(oid);
    const objects: Array<{ oid: string; object: GitObject }> = [];
    for (const oid of send) {
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push({ oid, object });
    }
    return { objects, shallowOut: [...boundary], unshallowOut: [...unshallow] };
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const id = this.nextId();
    const issue: Issue = {
      id,
      gid: issueGlobalId(repo.dbId, number),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.issues.length,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((i) => i.number === number) ?? null;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = repo.nextComment;
    repo.nextComment += 1;
    const comment: Comment = { id, gid: commentGlobalId(repo.dbId, issue.number, id), body };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  /** Line-diff counts between two blob contents (multiset line difference). */
  diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) oldCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCount.values()) deletions += left;
    return { additions, deletions };
  }

  /** The file diff between two trees, as the pulls files view reads it. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const oldText = b === undefined ? '' : (repo.objects.get(b.oid)?.data.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (repo.objects.get(h.oid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = this.diffLines(oldText, newText);
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return files;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.tipOf(repo, headRef);
    const baseSha = this.tipOf(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    const openDup = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
    if (openDup !== undefined) return null;
    const number = repo.nextPull;
    repo.nextPull += 1;
    const id = this.nextId();
    const headCommit = this.commitOf(repo, headSha);
    const baseCommit = this.commitOf(repo, baseSha);
    const files = this.diffTrees(repo, baseCommit?.tree ?? null, headCommit?.tree ?? null);
    const pull: Pull = {
      id,
      gid: pullGlobalId(repo.dbId, number),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      baseShaAtCreate: baseSha,
      files,
      seq: repo.pulls.length,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((p) => p.number === number) ?? null;
  }

  /** True when the pull request can merge without conflict (squash). */
  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = this.tipOf(repo, pull.baseRef);
    if (baseTip === null) return false;
    const baseCommit = this.commitOf(repo, baseTip);
    const createCommit = this.commitOf(repo, pull.baseShaAtCreate);
    const headCommit = this.commitOf(repo, pull.headSha);
    if (baseCommit === null || createCommit === null || headCommit === null) return false;
    const baseNow = this.flattenTree(repo, baseCommit.tree);
    const baseThen = this.flattenTree(repo, createCommit.tree);
    const head = this.flattenTree(repo, headCommit.tree);
    const headChanged = new Set<string>();
    for (const path of new Set([...baseThen.keys(), ...head.keys()])) {
      if ((baseThen.get(path)?.oid ?? null) !== (head.get(path)?.oid ?? null)) headChanged.add(path);
    }
    for (const path of headChanged) {
      const thenOid = baseThen.get(path)?.oid ?? null;
      const nowOid = baseNow.get(path)?.oid ?? null;
      const headOid = head.get(path)?.oid ?? null;
      if (nowOid !== thenOid && nowOid !== headOid) return false;
    }
    return true;
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (!this.mergeable(repo, pull)) return null;
    const baseTip = this.tipOf(repo, pull.baseRef);
    const headCommit = this.commitOf(repo, pull.headSha);
    if (baseTip === null || headCommit === null) return null;
    const message = `Merge pull request #${pull.number}`;
    const mergeSha = this.makeCommit(repo, pull.baseRef, headCommit.tree, [baseTip], message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeSha = mergeSha;
    return mergeSha;
  }
}

export function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}
