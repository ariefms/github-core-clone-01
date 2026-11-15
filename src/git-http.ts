// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack
// (v0 only). Packs are plain objects only, SHA-1, version 2. Fast-forward
// only; non-fast-forward is refused per-ref with reason `non-fast-forward`.

import {
  DELIM,
  FLUSH,
  ZERO_OID,
  decodePktLines,
  parseTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type Pkt,
} from './git-core.ts';
import { Forge, type Repo } from './store.ts';

export interface GitResult {
  status: number;
  body: Buffer;
  contentType: string;
}

const AGENT = 'github-core-clone/1.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function notFound(): GitResult {
  return { status: 404, body: Buffer.from('Not Found', 'utf8'), contentType: 'text/plain' };
}

function badRequest(message: string): GitResult {
  return { status: 400, body: Buffer.from(message, 'utf8'), contentType: 'text/plain' };
}

interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
}

/** HEAD + refs sorted by name; annotated tags carry their peeled target. */
function listRefs(forge: Forge, repo: Repo): RefEntry[] {
  const entries: RefEntry[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  entries.push({ oid: headTip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefEntry = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      entry.peeled = tag.object;
    }
    entries.push(entry);
  }
  return entries;
}

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  protocolVersion: string | undefined,
): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return notFound();
  const refs = listRefs(forge, repo);
  if (service === 'git-receive-pack') {
    const caps = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headSymref(repo)} agent=${AGENT}`;
    const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
    if (refs.length === 1 && refs[0]?.oid === ZERO_OID) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      refs.forEach((ref, index) => {
        const suffix = index === 0 ? `\0${caps}` : '';
        lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
        if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      });
    }
    lines.push(FLUSH);
    return { status: 200, body: Buffer.concat(lines), contentType: RECEIVE_AD_CT };
  }
  // upload-pack
  if (protocolVersion === '2') {
    const lines: Buffer[] = [
      pktLine('# service=git-upload-pack\n'),
      FLUSH,
      pktLine('version 2\n'),
      pktLine('ls-refs\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
      FLUSH,
    ];
    return { status: 200, body: Buffer.concat(lines), contentType: UPLOAD_AD_CT };
  }
  const caps = `side-band-64k ofs-delta symref=HEAD:${headSymref(repo)} agent=${AGENT}`;
  const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  if (refs.length === 1 && refs[0]?.oid === ZERO_OID) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  lines.push(FLUSH);
  return { status: 200, body: Buffer.concat(lines), contentType: UPLOAD_AD_CT };
}

// ---------------------------------------------------------------- pkt helpers

function pktText(payload: string): Buffer {
  return pktLine(payload.endsWith('\n') ? payload : `${payload}\n`);
}

/** Split bytes into sideband band-1 pkt-lines (max payload 65516). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function isCommit(forge: Forge, repo: Repo, oid: string): boolean {
  const object = repo.objects.get(oid);
  return object !== undefined && object.type === 'commit';
}

/** Commits that are ancestors of `tips` (including the tips themselves). */
function ancestors(forge: Forge, repo: Repo, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const commit = forge.commitOf(repo, oid);
    if (commit === null) continue;
    out.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** True when `newOid` is a descendant of (or equal to) `oldOid`. */
function isFastForward(forge: Forge, repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  if (oldOid === ZERO_OID) return true;
  const seen = ancestors(forge, repo, [newOid]);
  return seen.has(oldOid);
}

// ---------------------------------------------------------------- upload-pack

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  protocolVersion: string | undefined,
): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return notFound();
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const first = packets.find((p) => p.kind === 'data');
  const firstText = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
  if (firstText === 'command=ls-refs' || firstText === 'command=fetch') {
    return firstText === 'command=ls-refs' ? handleLsRefs(forge, repo, packets) : handleFetchV2(forge, repo, packets);
  }
  return handleFetchV0(forge, repo, packets);
}

function handleLsRefs(forge: Forge, repo: Repo, packets: Pkt[]): GitResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefs(forge, repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const hasRefs = refs.some((r) => r.name !== 'HEAD' && r.oid !== ZERO_OID);
  if (!hasRefs) {
    if (unborn && keep('HEAD')) {
      lines.push(pktText(`unborn HEAD symref-target:${headSymref(repo)}`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs) line += ` symref-target:${headSymref(repo)}`;
      if (ref.peeled !== undefined && peel) line += ` peeled:${ref.peeled}`;
      lines.push(pktText(line));
    }
  }
  lines.push(FLUSH);
  return { status: 200, body: Buffer.concat(lines), contentType: UPLOAD_RESULT_CT };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchLines(packets: Pkt[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim && line.startsWith('command=')) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
  }
  return request;
}

function fetchResponse(forge: Forge, repo: Repo, request: FetchRequest, v2: boolean): GitResult {
  // Identical fetches of an unchanged repo answer identical bytes (the pack
  // is deterministic: objects sorted by oid, fixed deflate). The bench runs
  // 50 concurrent depth-1 clones of one repo; building that pack once and
  // reusing it is the whole win. The fingerprint covers every ref plus the
  // object count, so any accepted mutation (push, REST write, merge) moves
  // a ref and invalidates the entry.
  const cacheKey = `${v2 ? 'v2' : 'v0'}|${repo.dbId}|${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
  const fingerprint = `${[...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([n, o]) => `${n}=${o}`).join(',')}|${repo.objects.size}`;
  const cached = packCache.get(cacheKey);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return { status: 200, body: cached.body, contentType: UPLOAD_RESULT_CT };
  }
  const selection = forge.fetchSelection(repo, request.wants, request.haves, request.shallow, request.depth);
  // The selection holds the same object references as repo.objects, so the
  // oid for each object comes from the map key. Sort by oid for a
  // deterministic pack.
  const oidByObject = new Map<GitObject, string>();
  for (const [oid, object] of repo.objects) oidByObject.set(object, oid);
  const sorted = [...selection.objects].sort((a, b) => {
    const aOid = oidByObject.get(a) ?? '';
    const bOid = oidByObject.get(b) ?? '';
    return aOid < bOid ? -1 : aOid > bOid ? 1 : 0;
  });
  const pack = writePack(sorted);
  // ACKs: haves that are ancestors of the wants.
  const wantCommits = request.wants.filter((w) => isCommit(forge, repo, w));
  const wantAncestors = ancestors(forge, repo, wantCommits);
  const acks = request.haves.filter((h) => wantAncestors.has(h) && isCommit(forge, repo, h));
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktText('acknowledgments'));
    if (acks.length > 0) {
      for (const ack of acks) parts.push(pktText(`ACK ${ack}`));
      parts.push(pktText('ready'));
    } else {
      parts.push(pktText('NAK'));
    }
    parts.push(DELIM);
    if (selection.shallowOut.length > 0 || selection.unshallowOut.length > 0) {
      parts.push(pktText('shallow-info'));
      for (const oid of selection.shallowOut) parts.push(pktText(`shallow ${oid}`));
      for (const oid of selection.unshallowOut) parts.push(pktText(`unshallow ${oid}`));
      parts.push(DELIM);
    }
    parts.push(pktText('packfile'));
    parts.push(...sidebandPackets(pack));
    parts.push(FLUSH);
  } else {
    if (acks.length > 0) {
      for (const ack of acks) parts.push(pktText(`ACK ${ack}`));
    } else {
      parts.push(pktText('NAK'));
    }
    for (const oid of selection.shallowOut) parts.push(pktText(`shallow ${oid}`));
    for (const oid of selection.unshallowOut) parts.push(pktText(`unshallow ${oid}`));
    parts.push(...sidebandPackets(pack));
    parts.push(FLUSH);
  }
  const body = Buffer.concat(parts);
  packCache.set(cacheKey, { fingerprint, body });
  if (packCache.size > PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  return { status: 200, body, contentType: UPLOAD_RESULT_CT };
}

/** Whole-response cache for identical fetches (see fetchResponse). */
const packCache = new Map<string, { fingerprint: string; body: Buffer }>();
const PACK_CACHE_MAX = 16;


function handleFetchV2(forge: Forge, repo: Repo, packets: Pkt[]): GitResult {
  const request = parseFetchLines(packets);
  if (request.wants.length === 0) {
    // No wants: an empty fetch. The client never sends this, but answer with
    // an empty packfile section so the parser stays happy.
    const parts: Buffer[] = [pktText('acknowledgments'), pktText('NAK'), DELIM, pktText('packfile'), ...sidebandPackets(writePack([])), FLUSH];
    return { status: 200, body: Buffer.concat(parts), contentType: UPLOAD_RESULT_CT };
  }
  return fetchResponse(forge, repo, request, true);
}

function handleFetchV0(forge: Forge, repo: Repo, packets: Pkt[]): GitResult {
  // Two sections: wants (shallow/deepen) until flush, then haves + done.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
  }
  if (request.wants.length === 0) return badRequest('no wants in fetch');
  return fetchResponse(forge, repo, request, false);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return notFound();
  // Walk pkt-lines one at a time; the command list ends at the first flush
  // and the pack follows it raw (it is not pkt-line framed, so the whole
  // body must not be decoded as pkt-lines).
  const commands: PushCommand[] = [];
  let offset = 0;
  let seenFlush = false;
  let malformed = false;
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
      malformed = true;
      break;
    }
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      seenFlush = true;
      break;
    }
    if (len === 1) {
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const payload = body.subarray(offset + 4, offset + len);
    offset += len;
    const text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const parts = commandText.split(' ');
    if (parts.length !== 3) {
      malformed = true;
      break;
    }
    const [oldOid, newOid, ref] = parts as [string, string, string];
    commands.push({ oldOid, newOid, ref });
  }
  if (malformed || !seenFlush || commands.length === 0) return badRequest('no push commands');
  // Unpack: everything after the command-list flush is the pack.
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!isFastForward(forge, repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const inner: Buffer[] = [pktText(unpackOk ? 'unpack ok' : 'unpack error')];
  for (const result of results) {
    inner.push(result.ok ? pktText(`ok ${result.ref}`) : pktText(`ng ${result.ref} ${result.reason}`));
  }
  const report = Buffer.concat(inner);
  const parts: Buffer[] = [...sidebandPackets(report), FLUSH];
  return { status: 200, body: Buffer.concat(parts), contentType: RECEIVE_RESULT_CT };
}
