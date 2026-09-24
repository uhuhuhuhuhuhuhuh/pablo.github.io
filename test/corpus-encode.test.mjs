// End-to-end IC2C encode/decode against an in-memory corpus catalog served by a mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFileToIc2, decodeIc2Token } from '../ic2-core.js';
import { encodeFileToIc2Corpus, decodeIc2CorpusToken, decodeIc2CorpusToSink } from '../ic2-corpus-share.js';
import { hex } from '../ic2-util.js';

console.warn = () => {};

function noise(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x >>> 24; }
  return out;
}

const SOURCE_URL = 'https://example.org/public/source.bin';
const source = noise(700000, 12345);
const files = new Map();

test.before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === SOURCE_URL) {
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
      const body = source.slice(Number(m[1]), Number(m[2]) + 1);
      return new Response(body, { status: 206 });
    }
    for (const [suffix, body] of files) if (href.endsWith(suffix)) return new Response(body, { status: 200 });
    return new Response('', { status: 404 });
  };
  files.set('/corpus/index.json', JSON.stringify({
    format: 'IC2_CORPUS_CATALOG_V1', prefix_hex_chars: 3, record_bytes: 48,
    sources: [{ id: 7, url: SOURCE_URL }], stats: { unique_chunks: 1 }
  }));
  const chunks = await chunkBoundaries(source);
  const shards = new Map();
  let offset = 0;
  for (const { hash, length } of chunks) {
    const rec = new Uint8Array(48), view = new DataView(rec.buffer);
    rec.set(hash, 0); view.setUint32(32, 7, true); view.setBigUint64(36, BigInt(offset), true); view.setUint32(44, length, true);
    const prefix = hex(hash).slice(0, 3);
    shards.set(prefix, [...(shards.get(prefix) || []), rec]);
    offset += length;
  }
  for (const [prefix, recs] of shards) {
    const body = new Uint8Array(recs.length * 48); recs.forEach((r, i) => body.set(r, i * 48));
    files.set(`/corpus/chunks/${prefix.slice(0, 2)}/${prefix.slice(2)}.bin`, body);
  }
});

// Reuse the encoder's own FastCDC boundaries: the source is small enough to encode as plain IC2.
async function chunkBoundaries(bytes) {
  const out = [];
  const { manifest } = await decodeIc2Token((await encodeFileToIc2(new File([bytes], 'src'))).token);
  for (const s of manifest.segments) for (let i = 0; i < s.repeatCount; i++) out.push({ hash: s.hash, length: s.unitLen });
  return out;
}

test('IC2C references matching public chunks and reconstructs exactly', async () => {
  const tail = noise(30000, 999);
  const file = new Uint8Array(source.length + tail.length); file.set(source); file.set(tail, source.length);
  const enc = await encodeFileToIc2Corpus(new File([file], 'f.bin'));
  assert.equal(enc.format, 'IC2C');
  assert.ok(enc.stats.corpus.matchedChunks > 0);
  // Only the chunk spanning the source/tail junction is embedded; the rest are 40-byte references.
  assert.ok(enc.token.length < file.length / 3, `token unexpectedly large: ${enc.token.length}`);

  const { manifest } = await decodeIc2CorpusToken(enc.token);
  assert.deepEqual(manifest.sources, [SOURCE_URL]);
  const parts = [];
  await decodeIc2CorpusToSink(manifest, { write: async b => { parts.push(Buffer.from(b)); } });
  assert.ok(Buffer.concat(parts).equals(Buffer.from(file)));
});

test('IC2C stops early once a file cannot fit the link budget', async () => {
  await assert.rejects(encodeFileToIc2Corpus(new File([noise(3_000_000, 4242)], 'n.bin')), e => e.code === 'IC2C_LINK_BUDGET');
});
