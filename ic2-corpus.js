const CATALOG_FORMAT = 'IC2_CORPUS_CATALOG_V1';
const CATALOG_URL = new URL('./corpus/index.json', import.meta.url);
const DEFAULT_PREFIX_HEX = 3;
const RECORD_BYTES = 48;
const MAX_FULL_RESPONSE = 64 * 1024 * 1024;
let catalogPromise = null;
const shardPromises = new Map();

function equalHashBytes(view, at, hashBytes) {
  for (let i = 0; i < 32; i++) if (view.getUint8(at + i) !== hashBytes[i]) return false;
  return true;
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(String(hex || ''))) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function getCorpusCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const response = await fetch(CATALOG_URL, { cache: 'no-store' });
        if (!response.ok) return null;
        const catalog = await response.json();
        if (catalog?.format !== CATALOG_FORMAT || !Array.isArray(catalog.sources)) return null;
        const sourceMap = new Map();
        for (const source of catalog.sources) {
          const id = Number(source?.id);
          const url = String(source?.url || '');
          if (!Number.isInteger(id) || id < 0 || !/^https?:\/\//i.test(url)) continue;
          sourceMap.set(id, { ...source, id, url });
        }
        return {
          ...catalog,
          prefix_hex_chars: Number(catalog.prefix_hex_chars || DEFAULT_PREFIX_HEX),
          record_bytes: Number(catalog.record_bytes || RECORD_BYTES),
          sourceMap
        };
      } catch {
        return null;
      }
    })();
  }
  return catalogPromise;
}

export async function corpusCatalogSummary() {
  const c = await getCorpusCatalog();
  return {
    available: !!(c && c.sourceMap?.size && Number(c.stats?.unique_chunks || 0) > 0),
    sources: c?.sourceMap?.size || 0,
    sourceBytes: Number(c?.stats?.source_bytes || 0),
    chunks: Number(c?.stats?.chunks || 0),
    uniqueChunks: Number(c?.stats?.unique_chunks || 0),
    generatedAt: c?.generated_at || ''
  };
}

function shardUrl(prefix) {
  return new URL(`./corpus/chunks/${prefix.slice(0, 2)}/${prefix.slice(2)}.bin`, import.meta.url);
}

async function loadShard(prefix, catalog) {
  if (!shardPromises.has(prefix)) {
    shardPromises.set(prefix, (async () => {
      try {
        const response = await fetch(shardUrl(prefix), { cache: 'no-store' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const recordBytes = catalog.record_bytes || RECORD_BYTES;
        if (recordBytes !== RECORD_BYTES || bytes.length % recordBytes) throw new Error('Invalid IC2 corpus shard length.');
        return bytes;
      } catch (error) {
        console.warn('IC2 corpus shard unavailable', prefix, error);
        return null;
      }
    })());
  }
  return shardPromises.get(prefix);
}

function findInShard(shard, hashBytes, length, catalog) {
  if (!shard) return null;
  const view = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
  for (let at = 0; at < shard.byteLength; at += RECORD_BYTES) {
    const n = view.getUint32(at + 44, true);
    if (n !== length || !equalHashBytes(view, at, hashBytes)) continue;
    const sourceId = view.getUint32(at + 32, true);
    const off = view.getBigUint64(at + 36, true);
    if (off > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const source = catalog.sourceMap.get(sourceId);
    if (!source) continue;
    return { sourceId, url: source.url, offset: Number(off), length: n, source };
  }
  return null;
}

export async function lookupExactCorpusChunks(items) {
  const catalog = await getCorpusCatalog();
  if (!catalog || !catalog.sourceMap?.size || !items?.length) return items?.map(() => null) || [];
  const prefixChars = Math.max(1, Math.min(8, catalog.prefix_hex_chars || DEFAULT_PREFIX_HEX));
  const normalized = items.map(item => ({
    hashHex: String(item.hashHex || '').toLowerCase(),
    length: Number(item.length || 0),
    hashBytes: item.hashBytes instanceof Uint8Array ? item.hashBytes : hexToBytes(String(item.hashHex || ''))
  }));
  const prefixes = [...new Set(normalized.filter(x => x.hashBytes).map(x => x.hashHex.slice(0, prefixChars)))];
  const loaded = new Map();
  await Promise.all(prefixes.map(async prefix => loaded.set(prefix, await loadShard(prefix, catalog))));
  return normalized.map(item => {
    if (!item.hashBytes) return null;
    const prefix = item.hashHex.slice(0, prefixChars);
    return findInShard(loaded.get(prefix), item.hashBytes, item.length, catalog);
  });
}

export async function fetchCorpusRange(url, offset, length) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Invalid corpus source URL.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new Error('Invalid corpus byte range.');
  const end = offset + length - 1;
  const response = await fetch(url, {
    mode: 'cors',
    cache: 'no-store',
    headers: { Range: `bytes=${offset}-${end}` }
  });
  if (response.status === 206) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) throw new Error(`Corpus range returned ${bytes.length} bytes; expected ${length}.`);
    return bytes;
  }
  if (response.status === 200) {
    const declared = Number(response.headers.get('Content-Length') || 0);
    if (offset === 0 && declared === length) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === length) return bytes;
    }
    if (declared && declared <= MAX_FULL_RESPONSE && offset + length <= declared) {
      const whole = new Uint8Array(await response.arrayBuffer());
      if (offset + length <= whole.length) return whole.slice(offset, offset + length);
    }
    try { await response.body?.cancel(); } catch {}
    throw new Error('Corpus source ignored the Range request and is too large to fetch safely as a whole object.');
  }
  throw new Error(`Corpus source range request failed with HTTP ${response.status}.`);
}
