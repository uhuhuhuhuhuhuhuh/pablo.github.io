import {
  MAX_TOKEN_CHARS, FASTCDC, BinWriter, BinReader,
  bytesToBase64Url, base64UrlToBytes, equalBytes, hex, Sha256, sha256
} from './ic2-util.js';
import { CODEC, compressBest, compressOuter, decompressOuter, decompressByCodec } from './compression.js';
import { corpusCatalogSummary, lookupExactCorpusChunks, fetchCorpusRange } from './ic2-corpus.js';

const MAGIC = Uint8Array.of(0x49, 0x43, 0x32, 0x43);
const VERSION = 1;
const HASH_ALGO_SHA256 = 1;
const BATCH_CHUNKS = 48;
const MAX_REPEAT_PATTERN = 256;
const MAX_SOURCES = 10000;
const MAX_URL_BYTES = 8192;
const MAX_SEGMENTS = 500000;
const TE = new TextEncoder();
const TD = new TextDecoder();

export const CORPUS_KIND = Object.freeze({ CORPUS:0, RAW:1, COMPRESSED:2, ZERO:3, CONSTANT:4, REPEAT:5, REF:6 });
export const CORPUS_KIND_NAME = Object.freeze({
  0:'public corpus exact reference', 1:'raw', 2:'compressed', 3:'zero recipe', 4:'constant recipe', 5:'repeat recipe', 6:'deduplicated reference'
});

const GEAR = (() => {
  const t = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    t[i] = x >>> 0;
  }
  return t;
})();

function cancelCheck(signal) { if (signal?.cancelled) throw new Error('Encoding cancelled.'); }

function detectRecipe(bytes) {
  if (!bytes.length) return null;
  const first = bytes[0];
  let same = true;
  for (let i = 1; i < bytes.length; i++) if (bytes[i] !== first) { same = false; break; }
  if (same) return first === 0 ? { kind:CORPUS_KIND.ZERO } : { kind:CORPUS_KIND.CONSTANT, value:first };
  for (const p of [2,4,8,16,32,64,128,256]) {
    if (p > MAX_REPEAT_PATTERN || bytes.length < p * 2 || bytes.length % p) continue;
    let ok = true;
    for (let i = p; i < bytes.length; i++) if (bytes[i] !== bytes[i % p]) { ok = false; break; }
    if (ok) return { kind:CORPUS_KIND.REPEAT, pattern:bytes.slice(0, p) };
  }
  return null;
}

function payloadBytes(seg) {
  if (seg.kind === CORPUS_KIND.RAW || seg.kind === CORPUS_KIND.COMPRESSED) return seg.data.length;
  if (seg.kind === CORPUS_KIND.REPEAT) return seg.pattern.length;
  return 0;
}

function addStat(stats, seg, rawBytes) {
  const name = CORPUS_KIND_NAME[seg.kind] || 'unknown';
  stats.byKind[name] = (stats.byKind[name] || 0) + rawBytes;
}

function assignSource(sourceUrls, sourceIndex, url) {
  if (sourceIndex.has(url)) return sourceIndex.get(url);
  const bytes = TE.encode(url);
  if (bytes.length > MAX_URL_BYTES) throw new Error('Corpus source URL is too long to embed safely.');
  if (sourceUrls.length >= MAX_SOURCES) throw new Error('Corpus-assisted manifest references too many distinct source objects.');
  const id = sourceUrls.length;
  sourceUrls.push(url); sourceIndex.set(url, id); return id;
}

export async function encodeFileToIc2Corpus(file, { onProgress=()=>{}, signal=null }={}) {
  const catalog = await corpusCatalogSummary();
  if (!catalog.available) {
    const e = new Error('No public chunk corpus catalog is installed.'); e.code = 'IC2C_NO_CATALOG'; throw e;
  }
  if (!file || typeof file.stream !== 'function') throw new Error('A browser File is required.');

  const fileHasher = new Sha256(), segments = [], seen = new Map(), sourceUrls = [], sourceIndex = new Map();
  const stats = {
    chunks:0, segments:0, rawBytes:0, embeddedBytes:0, byKind:{}, fastcdc:FASTCDC,
    corpus:{ available:true, catalogSources:catalog.sources, catalogChunks:catalog.uniqueChunks, matchedChunks:0, matchedBytes:0, distinctSources:0 }
  };
  const batch = [];
  let bytesSeen = 0;

  const processBatch = async () => {
    if (!batch.length) return;
    cancelCheck(signal);
    const matches = await lookupExactCorpusChunks(batch.map(x => ({ hashHex:x.hashHex, hashBytes:x.hashBytes, length:x.bytes.length })));
    for (let i = 0; i < batch.length; i++) {
      cancelCheck(signal);
      const item = batch[i], chunk = item.bytes;
      const recipe = detectRecipe(chunk);
      let rep;
      if (recipe) rep = recipe;
      else if (seen.has(item.hashHex) && seen.get(item.hashHex).unitLen === chunk.length) {
        rep = { kind:CORPUS_KIND.REF, base:seen.get(item.hashHex).segmentIndex };
      } else if (matches[i]) {
        const match = matches[i];
        rep = { kind:CORPUS_KIND.CORPUS, source:assignSource(sourceUrls, sourceIndex, match.url), offset:match.offset };
        stats.corpus.matchedChunks++;
        stats.corpus.matchedBytes += chunk.length;
      } else {
        const compressed = await compressBest(chunk, 8);
        rep = compressed.codec === CODEC.RAW
          ? { kind:CORPUS_KIND.RAW, data:chunk }
          : { kind:CORPUS_KIND.COMPRESSED, codec:compressed.codec, data:compressed.data };
      }
      const seg = { ...rep, unitLen:chunk.length, hash:item.hashBytes };
      const idx = segments.length;
      segments.push(seg);
      if (!seen.has(item.hashHex)) seen.set(item.hashHex, { segmentIndex:idx, unitLen:chunk.length });
      stats.chunks++; stats.rawBytes += chunk.length; addStat(stats, seg, chunk.length);
    }
    batch.length = 0;
    stats.corpus.distinctSources = sourceUrls.length;
    onProgress({ phase:'corpus', done:bytesSeen, total:file.size, segments:segments.length, stats });
  };

  const current = new Uint8Array(FASTCDC.max);
  let currentLen = 0, gear = 0;
  const flush = async () => {
    if (!currentLen) return;
    const bytes = current.slice(0, currentLen);
    const hashBytes = sha256(bytes);
    batch.push({ bytes, hashBytes, hashHex:hex(hashBytes) });
    currentLen = 0; gear = 0;
    if (batch.length >= BATCH_CHUNKS) await processBatch();
  };

  const reader = file.stream().getReader();
  while (true) {
    cancelCheck(signal);
    const { value, done } = await reader.read();
    if (done) break;
    const input = value instanceof Uint8Array ? value : new Uint8Array(value);
    fileHasher.update(input); bytesSeen += input.length;
    for (let i = 0; i < input.length; i++) {
      const b = input[i]; current[currentLen++] = b; gear = ((gear << 1) + GEAR[b]) >>> 0;
      if (currentLen >= FASTCDC.min) {
        const mask = currentLen < FASTCDC.avg ? 0x1ffff : 0x7fff;
        if (currentLen >= FASTCDC.max || (gear & mask) === 0) await flush();
      }
    }
    onProgress({ phase:'analyze', done:bytesSeen, total:file.size, segments:segments.length, stats });
  }
  await flush(); await processBatch();

  if (!stats.corpus.matchedChunks) {
    const e = new Error('No exact public corpus chunks matched this file.'); e.code = 'IC2C_NO_MATCH'; throw e;
  }

  stats.segments = segments.length;
  stats.embeddedBytes = segments.reduce((n, s) => n + payloadBytes(s), 0);
  const manifest = { version:VERSION, totalSize:file.size, fileHash:fileHasher.digest(), sources:sourceUrls, segments };
  const binary = encodeCorpusManifest(manifest);
  onProgress({ phase:'pack', done:file.size, total:file.size, segments:segments.length, stats, manifestBytes:binary.length });
  const outer = await compressOuter(binary);
  const token = `IC2C.${outer.mode}.${bytesToBase64Url(outer.data)}`;
  if (token.length > MAX_TOKEN_CHARS) {
    const e = new Error(`Corpus-assisted descriptor is ${token.length.toLocaleString()} characters, above the ${MAX_TOKEN_CHARS.toLocaleString()}-character link limit.`);
    e.code = 'IC2C_LINK_BUDGET'; throw e;
  }
  return { token, manifest, binaryBytes:binary.length, packedBytes:outer.data.length, outerMode:outer.mode, stats, learningSamples:[], format:'IC2C' };
}

export function encodeCorpusManifest(m) {
  const w = new BinWriter();
  w.bytes(MAGIC).u8(VERSION).u8(HASH_ALGO_SHA256).u8(FASTCDC.version).varint(m.totalSize).bytes(m.fileHash);
  w.varint(m.sources.length);
  for (const url of m.sources) { const b = TE.encode(url); w.varint(b.length).bytes(b); }
  w.varint(m.segments.length);
  for (const s of m.segments) {
    w.u8(s.kind).varint(s.unitLen).bytes(s.hash);
    if (s.kind === CORPUS_KIND.CORPUS) w.varint(s.source).varint(s.offset);
    else if (s.kind === CORPUS_KIND.RAW) w.varint(s.data.length).bytes(s.data);
    else if (s.kind === CORPUS_KIND.COMPRESSED) w.u8(s.codec).varint(s.data.length).bytes(s.data);
    else if (s.kind === CORPUS_KIND.ZERO) {}
    else if (s.kind === CORPUS_KIND.CONSTANT) w.u8(s.value);
    else if (s.kind === CORPUS_KIND.REPEAT) w.varint(s.pattern.length).bytes(s.pattern);
    else if (s.kind === CORPUS_KIND.REF) w.varint(s.base);
    else throw new Error(`Unknown IC2C segment kind ${s.kind}.`);
  }
  return w.finish();
}

export function decodeCorpusManifest(bytes) {
  const r = new BinReader(bytes);
  if (!equalBytes(r.take(4), MAGIC)) throw new Error('Not an IC2C binary manifest.');
  const version = r.u8(); if (version !== VERSION) throw new Error(`Unsupported IC2C version ${version}.`);
  if (r.u8() !== HASH_ALGO_SHA256) throw new Error('Unsupported IC2C hash algorithm.');
  if (r.u8() !== FASTCDC.version) throw new Error('Unsupported IC2C chunker version.');
  const totalSize = r.numberVarint('total size'), fileHash = r.take(32).slice();
  const sourceCount = r.numberVarint('source count'); if (sourceCount > MAX_SOURCES) throw new Error('IC2C source table is too large.');
  const sources = [];
  for (let i = 0; i < sourceCount; i++) {
    const n = r.numberVarint('source URL length'); if (n < 1 || n > MAX_URL_BYTES) throw new Error('Invalid IC2C source URL length.');
    const url = TD.decode(r.take(n)); if (!/^https?:\/\//i.test(url)) throw new Error('Invalid IC2C source URL.'); sources.push(url);
  }
  const count = r.numberVarint('segment count'); if (count > MAX_SEGMENTS) throw new Error('IC2C has too many segments.');
  const segments = []; let computed = 0n;
  for (let i = 0; i < count; i++) {
    const kind = r.u8(), unitLen = r.numberVarint('segment length');
    if (unitLen < 1 || unitLen > FASTCDC.max) throw new Error(`Invalid IC2C segment length at ${i}.`);
    const hash = r.take(32).slice(), s = { kind, unitLen, hash };
    if (kind === CORPUS_KIND.CORPUS) { s.source = r.numberVarint('source index'); s.offset = r.numberVarint('source offset'); if (s.source >= sources.length) throw new Error('Invalid IC2C source index.'); }
    else if (kind === CORPUS_KIND.RAW) { const n = r.numberVarint('raw length'); if (n !== unitLen) throw new Error('IC2C RAW length mismatch.'); s.data = r.take(n).slice(); }
    else if (kind === CORPUS_KIND.COMPRESSED) { s.codec = r.u8(); const n = r.numberVarint('compressed length'); s.data = r.take(n).slice(); }
    else if (kind === CORPUS_KIND.ZERO) {}
    else if (kind === CORPUS_KIND.CONSTANT) s.value = r.u8();
    else if (kind === CORPUS_KIND.REPEAT) { const n = r.numberVarint('repeat pattern'); if (n < 1 || n > MAX_REPEAT_PATTERN) throw new Error('Invalid IC2C repeat pattern.'); s.pattern = r.take(n).slice(); }
    else if (kind === CORPUS_KIND.REF) { s.base = r.numberVarint('base index'); if (s.base >= i) throw new Error('IC2C REF must point backward.'); }
    else throw new Error(`Unknown IC2C segment kind ${kind}.`);
    segments.push(s); computed += BigInt(unitLen);
  }
  if (!r.done) throw new Error('Unexpected trailing IC2C data.');
  if (computed !== BigInt(totalSize)) throw new Error('IC2C output size mismatch.');
  return { version, totalSize, fileHash, sources, segments };
}

export async function decodeIc2CorpusToken(token) {
  const m = /^IC2C\.([RZG])\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m) throw new Error('Not a valid IC2C token.');
  const packed = base64UrlToBytes(m[2]), binary = await decompressOuter(m[1], packed);
  return { manifest:decodeCorpusManifest(binary), binaryBytes:binary.length, packedBytes:packed.length, outerMode:m[1] };
}

function recipeUnit(s) {
  if (s.kind === CORPUS_KIND.ZERO) return new Uint8Array(s.unitLen);
  if (s.kind === CORPUS_KIND.CONSTANT) { const out = new Uint8Array(s.unitLen); out.fill(s.value); return out; }
  if (s.kind === CORPUS_KIND.REPEAT) { const out = new Uint8Array(s.unitLen); for (let p = 0; p < out.length; p += s.pattern.length) out.set(s.pattern.subarray(0, Math.min(s.pattern.length, out.length - p)), p); return out; }
  return null;
}

async function decodeUnit(manifest, s, index, cache) {
  let out = recipeUnit(s);
  if (!out) {
    if (s.kind === CORPUS_KIND.CORPUS) out = await fetchCorpusRange(manifest.sources[s.source], s.offset, s.unitLen);
    else if (s.kind === CORPUS_KIND.RAW) out = s.data.slice();
    else if (s.kind === CORPUS_KIND.COMPRESSED) out = await decompressByCodec(s.codec, s.data, s.unitLen);
    else if (s.kind === CORPUS_KIND.REF) { const base = cache.get(s.base); if (!base) throw new Error(`Missing IC2C reference base ${s.base}.`); out = base.slice(); }
  }
  if (!out || out.length !== s.unitLen) throw new Error(`IC2C segment ${index} produced the wrong length.`);
  if (!equalBytes(sha256(out), s.hash)) throw new Error(`IC2C segment ${index} failed SHA-256 verification. The public corpus object may have changed or the host returned the wrong byte range.`);
  return out;
}

export async function decodeIc2CorpusToSink(manifest, sink, { onProgress=()=>{}, signal=null }={}) {
  const referenced = new Set(manifest.segments.filter(s => s.kind === CORPUS_KIND.REF).map(s => s.base));
  const cache = new Map(), hasher = new Sha256(); let written = 0;
  for (let i = 0; i < manifest.segments.length; i++) {
    cancelCheck(signal);
    const unit = await decodeUnit(manifest, manifest.segments[i], i, cache);
    if (referenced.has(i)) cache.set(i, unit);
    hasher.update(unit); await sink.write(unit); written += unit.length;
    onProgress({ segment:i + 1, segments:manifest.segments.length, written, total:manifest.totalSize });
  }
  if (written !== manifest.totalSize) throw new Error(`IC2C reconstructed ${written} bytes but expected ${manifest.totalSize}.`);
  const finalHash = hasher.digest(); if (!equalBytes(finalHash, manifest.fileHash)) throw new Error('IC2C final SHA-256 verification failed.');
  if (sink.close) await sink.close();
  return { written, fileHash:finalHash };
}

export function summarizeIc2Corpus(manifest) {
  const counts = {}, bytes = {};
  for (const s of manifest.segments) {
    const n = CORPUS_KIND_NAME[s.kind] || `kind ${s.kind}`;
    counts[n] = (counts[n] || 0) + 1; bytes[n] = (bytes[n] || 0) + s.unitLen;
  }
  return { counts, bytes, segments:manifest.segments.length, totalSize:manifest.totalSize, sourceCount:manifest.sources.length, version:manifest.version };
}
