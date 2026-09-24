// Round-trip and integrity tests for the browser codecs, run with `node --test`.
// Zstandard is loaded from a CDN in the browser; under Node that import fails and
// the codecs fall back to gzip/raw, which is the path exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  sha256, Sha256, hex, bytesToBase64Url, base64UrlToBytes, BinWriter, BinReader, cleanFilename, formatBytes
} from '../ic2-util.js';
import { encodeFileToIc2, decodeIc2Token, decodeManifestToSink, encodeManifest, decodeManifest, KIND } from '../ic2-core.js';
import {
  CORPUS_KIND, encodeCorpusManifest, decodeCorpusManifest, decodeIc2CorpusToSink, planCorpusRanges
} from '../ic2-corpus-share.js';
import { createIcsToken, decodeIcsToken } from '../ics-share-codec.js';

console.warn = () => {}; // silence the expected "Zstandard unavailable" fallback notice

// Deterministic pseudo-random bytes so chunk boundaries (and thus the stats) are reproducible.
function noise(n, seed = 0x9e3779b9) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x >>> 24; }
  return out;
}
const nodeSha = b => createHash('sha256').update(b).digest('hex');
const collect = () => { const parts = []; return { parts, sink: { write: async b => { parts.push(Buffer.from(b)); }, close: async () => {} } }; };

async function roundTrip(bytes, name = 'file.bin') {
  const enc = await encodeFileToIc2(new File([bytes], name));
  assert.match(enc.token, /^IC2\.[RZG]\.[A-Za-z0-9_-]+$/);
  const { manifest } = await decodeIc2Token(enc.token);
  const { parts, sink } = collect();
  await decodeManifestToSink(manifest, sink);
  assert.ok(Buffer.concat(parts).equals(Buffer.from(bytes)), 'reconstructed bytes differ');
  return enc;
}

test('SHA-256 matches node:crypto across padding boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70000]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(hex(sha256(b)), nodeSha(b), `length ${n}`);
  }
});

test('incremental SHA-256 matches one-shot', () => {
  const b = new Uint8Array(randomBytes(300001)), h = new Sha256();
  for (let i = 0; i < b.length; i += 7777) h.update(b.subarray(i, i + 7777));
  assert.equal(hex(h.digest()), nodeSha(b));
});

test('base64url round-trips and rejects invalid characters', () => {
  for (const n of [0, 1, 2, 3, 100, 70000]) {
    const b = new Uint8Array(randomBytes(n));
    assert.deepEqual(base64UrlToBytes(bytesToBase64Url(b)), b);
  }
  assert.throws(() => base64UrlToBytes('abc+/'));
});

test('varints round-trip', () => {
  const values = [0, 1, 127, 128, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER];
  const w = new BinWriter(); for (const v of values) w.varint(v);
  const r = new BinReader(w.finish());
  for (const v of values) assert.equal(r.numberVarint(), v);
  assert.ok(r.done);
});

test('filename and size helpers', () => {
  assert.equal(cleanFilename('../a/b\\c\u0000.txt'), '.._a_b_c_.txt');
  assert.equal(cleanFilename('   '), 'shared-file.bin');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.50 KiB');
});

test('IC2 round-trips empty, tiny and text files', async () => {
  await roundTrip(new Uint8Array(0));
  await roundTrip(Uint8Array.of(42));
  await roundTrip(new TextEncoder().encode('The Infinite Corridor '.repeat(20000)), 'a.txt');
});

test('IC2 uses recipes for zero, constant, counter and repeating data', async () => {
  const zero = await roundTrip(new Uint8Array(1 << 20));
  assert.ok(zero.stats.byKind['zero recipe'] > 0);
  assert.ok(zero.token.length < 2000);
  await roundTrip(new Uint8Array(300000).fill(7));
  const counter = new Uint8Array(200000); for (let i = 0; i < counter.length; i++) counter[i] = i & 255;
  await roundTrip(counter);
  const pattern = new Uint8Array(200000); for (let i = 0; i < pattern.length; i++) pattern[i] = [1, 2, 3, 5][i % 4];
  await roundTrip(pattern);
});

test('IC2 deduplicates repeated random blocks and applies deltas', async () => {
  const block = noise(300000);
  const repeated = new Uint8Array(block.length * 3);
  for (let i = 0; i < 3; i++) repeated.set(block, i * block.length);
  const enc = await roundTrip(repeated);
  assert.ok(enc.stats.embeddedBytes < block.length * 2, 'repeats should not be embedded again');
  assert.ok(enc.stats.byKind['deduplicated reference'] > 0);

  const edited = repeated.slice(); for (let i = 400000; i < 400010; i++) edited[i] ^= 0xff;
  await roundTrip(edited);
});

test('IC2 rejects files that cannot fit in a link', async () => {
  await assert.rejects(encodeFileToIc2(new File([randomBytes(1_300_000)], 'noise.bin')), e => e.code === 'IC2_LINK_BUDGET');
});

test('IC2 detects tampered manifests', async () => {
  const text = new TextEncoder().encode('corridor '.repeat(5000));
  const enc = await encodeFileToIc2(new File([text], 'a.txt'));
  const binary = encodeManifest(enc.manifest);

  const badHash = decodeManifest(binary); badHash.fileHash[0] ^= 1;
  await assert.rejects(decodeManifestToSink(badHash, collect().sink), /final SHA-256/);

  const badSegment = decodeManifest(binary); badSegment.segments[0].hash[0] ^= 1;
  await assert.rejects(decodeManifestToSink(badSegment, collect().sink), /SHA-256 verification/);

  assert.throws(() => decodeManifest(binary.subarray(0, binary.length - 1)));
  assert.throws(() => decodeManifest(new Uint8Array([...binary, 0])), /trailing/);
  await assert.rejects(decodeIc2Token('IC2.X.abc'), /Not a valid IC2 token/);
});

test('IC2 decoder rejects forward references', () => {
  const seg = { kind: KIND.REF, unitLen: 1, repeatCount: 1, hash: new Uint8Array(32), base: 0 };
  const m = { version: 3, salt: new Uint8Array(16), totalSize: 1, fileHash: new Uint8Array(32), dictionary: new Uint8Array(), segments: [seg] };
  assert.throws(() => decodeManifest(encodeManifest(m)), /point backward/);
});

test('ICS1 legacy tokens round-trip and detect corruption', async () => {
  const bytes = new TextEncoder().encode('legacy '.repeat(1000));
  const { token } = await createIcsToken(bytes);
  assert.deepEqual((await decodeIcsToken(token)).bytes, bytes);
  const parts = token.split('.'); parts[3] = bytesToBase64Url(new Uint8Array(32));
  await assert.rejects(decodeIcsToken(parts.join('.')), /integrity/);
});

// A fake public source object served through a mocked fetch that honours Range.
function mockCorpus(source) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
    calls.push(m ? [Number(m[1]), Number(m[2])] : null);
    const body = m ? source.slice(Number(m[1]), Number(m[2]) + 1) : source;
    return new Response(body, { status: m ? 206 : 200, headers: { 'Content-Length': String(body.length) } });
  };
  return calls;
}

function corpusManifest(source, url) {
  // Three adjacent source chunks, a raw chunk, then a non-adjacent source chunk and a back-reference.
  const cuts = [[0, 70000], [70000, 50000], [120000, 60000]];
  const raw = new Uint8Array(randomBytes(20000));
  const segments = cuts.map(([o, n]) => ({ kind: CORPUS_KIND.CORPUS, unitLen: n, hash: sha256(source.subarray(o, o + n)), source: 0, offset: o }));
  segments.push({ kind: CORPUS_KIND.RAW, unitLen: raw.length, hash: sha256(raw), data: raw });
  segments.push({ kind: CORPUS_KIND.CORPUS, unitLen: 30000, hash: sha256(source.subarray(10000, 40000)), source: 0, offset: 10000 });
  segments.push({ kind: CORPUS_KIND.REF, unitLen: raw.length, hash: sha256(raw), base: 3 });
  const expected = Buffer.concat([source.subarray(0, 180000), raw, source.subarray(10000, 40000), raw]);
  const manifest = { version: 1, totalSize: expected.length, fileHash: sha256(expected), sources: [url], segments };
  return { manifest: decodeCorpusManifest(encodeCorpusManifest(manifest)), expected };
}

test('IC2C manifest round-trips and coalesces adjacent byte ranges', async () => {
  const source = new Uint8Array(randomBytes(200000));
  const { manifest, expected } = corpusManifest(source, 'https://example.org/object.bin');
  assert.equal(planCorpusRanges(manifest.segments).ranges.length, 2);

  const calls = mockCorpus(source);
  const { parts, sink } = collect();
  await decodeIc2CorpusToSink(manifest, sink);
  assert.ok(Buffer.concat(parts).equals(expected));
  assert.deepEqual(calls, [[0, 179999], [10000, 39999]]);
});

test('IC2C fails verification when the source object changes', async () => {
  const source = new Uint8Array(randomBytes(200000));
  const { manifest } = corpusManifest(source, 'https://example.org/object.bin');
  const changed = source.slice(); changed[100] ^= 1;
  mockCorpus(changed);
  await assert.rejects(decodeIc2CorpusToSink(manifest, collect().sink), /failed SHA-256 verification/);
});

test('IC2C decoder rejects non-HTTP source URLs', () => {
  const m = { version: 1, totalSize: 0, fileHash: sha256(new Uint8Array()), sources: ['javascript:alert(1)'], segments: [] };
  assert.throws(() => decodeCorpusManifest(encodeCorpusManifest(m)), /Invalid IC2C source URL/);
});
