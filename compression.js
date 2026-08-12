const ZSTD_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/index.web.js';
const ZSTD_WASM_URL = 'https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.wasm';
let zstdPromise;
let dictCCtx = 0;
let dictDCtx = 0;

export const CODEC = Object.freeze({ RAW:0, ZSTD:1, GZIP:2 });

async function gzip(bytes) {
  if (!('CompressionStream' in globalThis)) return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  if (!('DecompressionStream' in globalThis)) throw new Error('This browser cannot decompress gzip data.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function getZstd() {
  if (!zstdPromise) {
    zstdPromise = (async () => {
      try {
        const mod = await import(ZSTD_MODULE_URL);
        await mod.init(ZSTD_WASM_URL);
        return mod;
      } catch (error) {
        console.warn('Zstandard WASM unavailable; falling back to gzip/raw.', error);
        return null;
      }
    })();
  }
  return zstdPromise;
}

export async function compressBest(bytes, level=8) {
  const zstd = await getZstd();
  if (zstd) {
    try {
      const data = zstd.compress(bytes, level);
      if (data.length + 8 < bytes.length) return { codec: CODEC.ZSTD, data };
    } catch (error) { console.warn('zstd compression failed', error); }
  }
  try {
    const data = await gzip(bytes);
    if (data && data.length + 8 < bytes.length) return { codec: CODEC.GZIP, data };
  } catch (error) { console.warn('gzip compression failed', error); }
  return { codec: CODEC.RAW, data: bytes };
}

export async function compressWithDictionary(bytes, dictionary, level=8) {
  if (!dictionary || dictionary.length < 256) return null;
  const zstd = await getZstd();
  if (!zstd?.compressUsingDict || !zstd?.createCCtx) return null;
  try {
    if (!dictCCtx) dictCCtx = zstd.createCCtx();
    return zstd.compressUsingDict(dictCCtx, bytes, dictionary, level);
  } catch (error) {
    console.warn('zstd dictionary compression failed', error);
    return null;
  }
}

export async function decompressWithDictionary(bytes, dictionary, expectedLength) {
  if (!dictionary || !dictionary.length) throw new Error('IC2.1 dictionary data is missing.');
  const zstd = await getZstd();
  if (!zstd?.decompressUsingDict || !zstd?.createDCtx) throw new Error('This IC2.1 share needs Zstandard dictionary support, but the pinned component could not be loaded.');
  if (!dictDCtx) dictDCtx = zstd.createDCtx();
  const out = zstd.decompressUsingDict(dictDCtx, bytes, dictionary, expectedLength === undefined ? undefined : { defaultHeapSize: expectedLength });
  if (expectedLength !== undefined && out.length !== expectedLength) throw new Error(`Decoded dictionary chunk length mismatch: expected ${expectedLength}, got ${out.length}.`);
  return out;
}

export async function decompressByCodec(codec, bytes, expectedLength) {
  let out;
  if (codec === CODEC.RAW) out = bytes.slice();
  else if (codec === CODEC.ZSTD) {
    const zstd = await getZstd();
    if (!zstd) throw new Error('This IC2 link uses Zstandard, but the pinned Zstandard component could not be loaded.');
    out = zstd.decompress(bytes);
  } else if (codec === CODEC.GZIP) out = await gunzip(bytes);
  else throw new Error(`Unsupported IC2 compression codec ${codec}.`);
  if (expectedLength !== undefined && out.length !== expectedLength) throw new Error(`Decoded chunk length mismatch: expected ${expectedLength}, got ${out.length}.`);
  return out;
}

export async function compressOuter(bytes) {
  const packed = await compressBest(bytes, 8);
  if (packed.codec === CODEC.ZSTD) return { mode:'Z', data:packed.data };
  if (packed.codec === CODEC.GZIP) return { mode:'G', data:packed.data };
  return { mode:'R', data:bytes };
}
export async function decompressOuter(mode, bytes) {
  if (mode === 'R') return bytes;
  if (mode === 'Z') return decompressByCodec(CODEC.ZSTD, bytes);
  if (mode === 'G') return decompressByCodec(CODEC.GZIP, bytes);
  throw new Error(`Unsupported IC2 outer mode ${mode}.`);
}
export const compressionRuntimeInfo = () => ({ zstdModule: ZSTD_MODULE_URL, zstdWasm: ZSTD_WASM_URL });
