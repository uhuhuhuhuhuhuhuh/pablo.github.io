#!/usr/bin/env node
// Maintain the static IC2C corpus catalog (corpus/index.json + corpus/chunks/**) in place.
//
//   node tools/corpus.mjs probe  [--out probe.json] [--kind archive.org]   check every source works from a browser
//   node tools/corpus.mjs prune  --report probe.json                       drop sources the probe marked unusable
//   node tools/corpus.mjs add    urls.txt [--label jsdelivr]               stream, chunk and append new sources
//   node tools/corpus.mjs verify <source-id>                               re-chunk a source and check the catalog
//
// Chunking uses the browser's own FastCdc, so boundaries always match what the
// share page computes. Shards keep the builder's invariant: records sorted by
// (hash, length, source, offset) with one record per (hash, length).
// Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FastCdc } from '../ic2-util.js';

const ROOT = process.env.CORPUS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
const INDEX = path.join(ROOT, 'index.json');
const REC = 48, PREFIX = 3;
// Probes send the site's origin so hosts answer CORS exactly as they would for visitors.
const ORIGIN = 'https://uhuhuhuhuhuhuhuh.github.io';
const MAX_SOURCE_BYTES = 2.25 * 1024 ** 3;

const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const loadIndex = () => JSON.parse(fs.readFileSync(INDEX, 'utf8'));
function saveIndex(index) {
  index.generated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const tmp = INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, INDEX);
}
const shardPath = prefix => path.join(ROOT, 'chunks', prefix.slice(0, 2), `${prefix.slice(2)}.bin`);
function readShard(prefix) {
  const file = shardPath(prefix);
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file), rows = [];
  for (let at = 0; at < buf.length; at += REC) rows.push(Buffer.from(buf.subarray(at, at + REC)));
  return rows;
}
const rowLen = r => r.readUInt32LE(44), rowSource = r => r.readUInt32LE(32);
function writeShard(prefix, rows) {
  rows.sort((a, b) => Buffer.compare(a.subarray(0, 32), b.subarray(0, 32)) || rowLen(a) - rowLen(b) || rowSource(a) - rowSource(b) || Number(a.readBigUInt64LE(36) - b.readBigUInt64LE(36)));
  const dedup = rows.filter((r, i) => i === 0 || Buffer.compare(r.subarray(0, 32), rows[i - 1].subarray(0, 32)) || rowLen(r) !== rowLen(rows[i - 1]));
  const file = shardPath(prefix);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(dedup));
  return dedup.length;
}
function allPrefixes() {
  const out = [];
  for (const dir of fs.readdirSync(path.join(ROOT, 'chunks'))) for (const f of fs.readdirSync(path.join(ROOT, 'chunks', dir))) if (f.endsWith('.bin')) out.push(dir + f.slice(0, -4));
  return out.sort();
}
function recountStats(index) {
  let unique = 0;
  for (const p of allPrefixes()) unique += fs.statSync(shardPath(p)).size / REC;
  index.stats = {
    ...index.stats,
    source_files: index.sources.length,
    source_bytes: index.sources.reduce((n, s) => n + (s.size || 0), 0),
    unique_chunks: unique,
    shards: allPrefixes().length
  };
}

// A browser can use a source only if a CORS Range request returns 206 with Access-Control-Allow-Origin.
async function probeUrl(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-99', Origin: ORIGIN }, signal: AbortSignal.timeout(45000) });
    const ok = res.status === 206 && !!res.headers.get('access-control-allow-origin');
    try { await res.body?.cancel(); } catch {}
    return { ok, status: res.status, cors: !!res.headers.get('access-control-allow-origin') };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.cause?.code || error?.message || error) };
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

// Streams a URL once, returning its FastCDC chunk records and whole-object SHA-256.
async function chunkUrl(url, onChunk) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) { await res.body.cancel(); throw new Error(`too large (${declared} bytes)`); }
  const cdc = new FastCdc(), whole = createHash('sha256');
  let offset = 0;
  const emit = chunk => { onChunk(createHash('sha256').update(chunk).digest(), offset, chunk.length); offset += chunk.length; };
  for await (const part of res.body) {
    const input = part instanceof Uint8Array ? part : new Uint8Array(part);
    whole.update(input);
    for (const chunk of cdc.push(input)) emit(chunk);
    if (offset > MAX_SOURCE_BYTES) throw new Error('too large');
  }
  for (const chunk of cdc.finish()) emit(chunk);
  return { size: offset, sha256: whole.digest('hex') };
}

async function probe() {
  const index = loadIndex(), kind = flag('kind');
  const sources = index.sources.filter(s => !kind || s.source.split(':')[0] === kind);
  log(`probing ${sources.length} sources`);
  let done = 0;
  const results = await mapLimit(sources, 24, async s => {
    const r = { id: s.id, url: s.url, ...(await probeUrl(s.url)) };
    if (++done % 100 === 0) log(`${done}/${sources.length}`);
    return r;
  });
  const bad = results.filter(r => !r.ok);
  const byHost = {};
  for (const r of bad) { const h = new URL(r.url).host; byHost[h] = (byHost[h] || 0) + 1; }
  log(`${results.length - bad.length} usable, ${bad.length} unusable`, byHost);
  fs.writeFileSync(flag('out', 'probe.json'), JSON.stringify(results, null, 1));
}

function prune() {
  const report = JSON.parse(fs.readFileSync(flag('report', 'probe.json'), 'utf8'));
  const drop = new Set(report.filter(r => !r.ok).map(r => r.id));
  const index = loadIndex();
  const before = index.sources.length;
  index.sources = index.sources.filter(s => !drop.has(s.id));
  let removed = 0;
  for (const prefix of allPrefixes()) {
    const rows = readShard(prefix), keep = rows.filter(r => !drop.has(rowSource(r)));
    if (keep.length !== rows.length) { removed += rows.length - keep.length; writeShard(prefix, keep); }
  }
  index.stats.chunks = Math.max(0, (index.stats.chunks || 0) - removed);
  recountStats(index);
  saveIndex(index);
  log(`removed ${before - index.sources.length} sources and ${removed} chunk records`);
}

async function add() {
  const list = fs.readFileSync(args[1], 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const label = flag('label', 'url-list');
  const index = loadIndex();
  const known = new Set(index.sources.map(s => s.url));
  let nextId = Math.max(0, ...index.sources.map(s => s.id)) + 1, added = 0, bytes = 0;
  const pending = new Map(); // prefix -> new rows, flushed periodically to bound memory
  const flush = () => {
    for (const [prefix, rows] of pending) writeShard(prefix, readShard(prefix).concat(rows));
    pending.clear();
    recountStats(index); saveIndex(index);
  };
  const urls = list.filter(u => !known.has(u));
  log(`${urls.length} new URLs (${list.length - urls.length} already catalogued)`);
  await mapLimit(urls, Number(flag('parallel', 4)), async url => {
    const probe = await probeUrl(url);
    if (!probe.ok) { log('skip (not browser-fetchable)', probe.status, url); return; }
    const id = nextId++, rows = [];
    try {
      const info = await chunkUrl(url, (hash, offset, length) => {
        const r = Buffer.alloc(REC); hash.copy(r, 0); r.writeUInt32LE(id, 32); r.writeBigUInt64LE(BigInt(offset), 36); r.writeUInt32LE(length, 44);
        rows.push(r);
      });
      for (const r of rows) { const p = r.subarray(0, 32).toString('hex').slice(0, PREFIX); if (!pending.has(p)) pending.set(p, []); pending.get(p).push(r); }
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
      index.sources.push({ id, url, name, source: label, size: info.size, sha256: info.sha256 });
      index.stats.chunks = (index.stats.chunks || 0) + rows.length;
      added++; bytes += info.size;
      log(`+ #${id} ${rows.length} chunks ${(info.size / 1048576).toFixed(1)} MiB ${url}`);
      if (added % 50 === 0) flush();
    } catch (error) { log('skip', error.message, url); }
  });
  index.sources.sort((a, b) => a.id - b.id);
  flush();
  log(`added ${added} sources, ${(bytes / 1073741824).toFixed(2)} GiB`);
}

async function verify() {
  const id = Number(args[1]), index = loadIndex(), src = index.sources.find(s => s.id === id);
  if (!src) throw new Error(`no source ${id}`);
  let total = 0, found = 0;
  const shards = new Map();
  const info = await chunkUrl(src.url, (hash, offset, length) => {
    total++;
    const p = hash.toString('hex').slice(0, PREFIX);
    if (!shards.has(p)) shards.set(p, readShard(p));
    if (shards.get(p).some(r => r.subarray(0, 32).equals(hash) && rowLen(r) === length)) found++;
  });
  log(`source #${id}: ${found}/${total} chunks found, sha256 ${info.sha256 === src.sha256 ? 'matches' : 'DIFFERS'}`);
  if (found !== total || info.sha256 !== src.sha256) process.exitCode = 1;
}

const commands = { probe, prune, add, verify };
if (!commands[args[0]]) { console.error('usage: corpus.mjs probe|prune|add|verify ...'); process.exit(2); }
await commands[args[0]]();
