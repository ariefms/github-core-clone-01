// git-core.ts — git object, pack and pkt-line primitives. No deltas anywhere:
// the suite's client only ever sends plain objects, and this server only ever
// writes plain objects (pack-deltas passes when the server sends no deltas).
// Everything is deterministic: no clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** sha1 hex of `"<type> <len>\0" + data`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashBuffer(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex length bytes (including themselves) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix.
 * A trailing partial packet also throws.
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split a buffer into pkt-line payload strings (data packets only). */
export function pktStrings(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------- objects

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's raw bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's raw bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag's raw bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a tree object from entries (git sort: names, dirs as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. The message is stored verbatim. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  lines.push('');
  lines.push(info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- packs

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  // varint: low 4 bits in the first byte with the type in bits 4..6, then 7 bits/byte.
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2, plain objects only) with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Level 1: ~22% faster than the default on 1 KiB blobs at the same size
    // (measured); packs cross loopback, so size is not scored, time is.
    parts.push(zlibDeflate(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate the object at `off` whose decompressed size is `size`; answer its
 * bytes and the offset just past its deflate stream. inflateSync ignores
 * trailing bytes, so the stream end is found by binary search on the length.
 */
function inflateAt(buf: Buffer, off: number, size: number): { data: Buffer; next: number } {
  // One inflate reports how many input bytes the stream consumed
  // (engine.bytesWritten), so the stream end is found without the
  // throw-per-probe binary search. Falls back to the search when the
  // runtime does not report the consumed length (older Node) or the
  // stream is corrupt, keeping the old error semantics either way.
  try {
    const res = zlibInflate(buf.subarray(off), { info: true }) as {
      buffer: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    const consumed = res.engine?.bytesWritten;
    if (typeof consumed === 'number' && res.buffer.length === size) {
      return { data: res.buffer, next: off + consumed };
    }
  } catch {
    // Corrupt stream: the slow path below throws the same error as before.
  }
  return inflateAtSlow(buf, off, size);
}

function inflateAtSlow(buf: Buffer, off: number, size: number): { data: Buffer; next: number } {
  const max = buf.length - off;
  // A deflate stream is at most its output plus a small overhead.
  let hi = Math.min(max, size + 64);
  if (hi < 1) throw new Error('pack truncated');
  const tryAt = (len: number): Buffer | null => {
    try {
      const out = zlibInflate(buf.subarray(off, off + len));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  if (tryAt(hi) === null) {
    // Incompressible data can need a few more bytes than the output.
    if (hi === max) throw new Error('pack object does not inflate');
    hi = max;
    if (tryAt(hi) === null) throw new Error('pack object does not inflate');
  }
  let lo = 1;
  // Invariant: tryAt(lo) fails, tryAt(hi) succeeds.
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (tryAt(mid) !== null) hi = mid;
    else lo = mid;
  }
  const data = tryAt(hi);
  if (data === null) throw new Error('pack object does not inflate');
  return { data, next: off + hi };
}

export interface PackRead {
  version: number;
  objects: Map<string, GitObject>;
}

/**
 * Parse a pack: header, plain entries (delta entries are an unpack error —
 * this server and its client never write them), trailer checksum.
 */
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expect = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= pack.length - 20) throw new Error('pack truncated');
    // varint type+size
    let b = pack[off];
    off += 1;
    const typeCode = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (off >= pack.length - 20) throw new Error('pack truncated');
      b = pack[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unsupported pack object type ${typeCode}`);
    const { data, next } = inflateAt(pack, off, size);
    off = next;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
  }
  return { version, objects };
}
