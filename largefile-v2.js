const $ = (s) => document.querySelector(s);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BYTES = 1n << 40n; // 1 TiB
const CHUNK_SIZE = 4 * 1024 * 1024;
const PNG_STREAM_CHUNK_DATA = 64 * 1024 * 1024;
const FORMAT_TYPES = new Set(['text', 'json', 'pdf', 'png', 'zip', 'safetensors', 'gguf']);

let cancelRequested = false;
let loadedFormatRecipe = null;
let suppressRecipeReset = false;

const multipliers = {
  B: 1n,
  KiB: 1n << 10n,
  MiB: 1n << 20n,
  GiB: 1n << 30n,
  TiB: 1n << 40n,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function parseSize() {
  const raw = $('#xl-size').value.trim();
  const unit = $('#xl-unit').value;
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('Enter a positive size with up to 6 decimal places.');
  const [whole, frac = ''] = raw.split('.');
  const scale = 10n ** BigInt(frac.length);
  const scaled = BigInt(whole + frac);
  const bytes = (scaled * multipliers[unit]) / scale;
  if (bytes < 1n) throw new Error('File size must be at least 1 byte.');
  if (bytes > MAX_BYTES) throw new Error('This build caps XL objects at 1 TiB.');
  return bytes;
}

function formatBigBytes(n) {
  const units = [['TiB', 1n<<40n], ['GiB', 1n<<30n], ['MiB', 1n<<20n], ['KiB', 1n<<10n]];
  for (const [name, size] of units) {
    if (n >= size) {
      const whole = n / size;
      const rem = Number((n % size) * 100n / size);
      return `${whole}.${String(rem).padStart(2,'0')} ${name}`;
    }
  }
  return `${n} B`;
}

function base64urlEncode(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function base64urlDecode(value) {
  const b64 = value.replaceAll('-','+').replaceAll('_','/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return decoder.decode(bytes);
}

function chooseExactUnit(size) {
  const choices = [['TiB',1n<<40n],['GiB',1n<<30n],['MiB',1n<<20n],['KiB',1n<<10n],['B',1n]];
  return choices.find(([,m]) => size % m === 0n) || ['B',1n];
}

function currentAddress(size = parseSize()) {
  if (loadedFormatRecipe) return loadedFormatRecipe.address;
  const mode = $('#xl-mode').value;
  let payload = '-';
  if (mode === 'text') {
    const text = $('#xl-pattern').value;
    if (!text.length) throw new Error('Enter a repeating text pattern.');
    if (encoder.encode(text).length > 65536) throw new Error('Repeating text pattern is capped at 64 KiB.');
    payload = base64urlEncode(text);
  } else if (mode === 'seeded') {
    const seed = $('#xl-seed').value || 'infinite-corridor';
    payload = base64urlEncode(seed);
  }
  return `ICXL1:${size}:${mode}:${payload}`;
}

function fnv1a(text) {
  const bytes = encoder.encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 0x9e3779b9;
}

function makeByteGenerator(seedText) {
  let x = fnv1a(seedText);
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x & 0xff;
  };
}

function fillFromGenerator(length, next, alphabet = null) {
  const out = new Uint8Array(length);
  if (alphabet) {
    for (let i = 0; i < length; i++) out[i] = alphabet[next() % alphabet.length];
  } else {
    for (let i = 0; i < length; i++) out[i] = next();
  }
  return out;
}

function makeTemplate(mode) {
  if (mode === 'zero') return new Uint8Array(CHUNK_SIZE);
  if (mode === 'counter') {
    const out = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
    return out;
  }
  if (mode === 'text') {
    const pattern = encoder.encode($('#xl-pattern').value);
    if (!pattern.length) throw new Error('Enter a repeating text pattern.');
    const out = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length];
    return out;
  }
  if (mode === 'seeded') {
    const out = new Uint8Array(CHUNK_SIZE);
    const next = makeByteGenerator($('#xl-seed').value || 'infinite-corridor');
    for (let i = 0; i < out.length; i++) out[i] = next();
    return out;
  }
  throw new Error('Unknown XL generation mode.');
}

function clearFormatRecipe() {
  if (suppressRecipeReset || !loadedFormatRecipe) return;
  loadedFormatRecipe = null;
  $('#xl-status').textContent = 'Format recipe detached; editing now uses a normal ICXL1 recipe.';
}

function updateModeUi() {
  const mode = $('#xl-mode').value;
  $('#xl-text-options').hidden = mode !== 'text';
  $('#xl-seed-options').hidden = mode !== 'seeded';
  updateSummary();
}

function approximateDepthText(size) {
  const cap = 10_000_000_000_000n;
  const clipped = size > cap ? cap : size;
  const equivalentLevels = Math.ceil(Number(clipped) * 0.6526048787340432);
  return size <= cap ? equivalentLevels.toLocaleString() : '>6.5 trillion';
}

function updateSummary() {
  const target = $('#xl-summary');
  try {
    const size = parseSize();
    const address = currentAddress(size);
    if (loadedFormatRecipe) {
      target.innerHTML = `<strong>${formatBigBytes(size)}</strong> format-aware virtual object<br><span class="muted">Loaded ${escapeHtml(loadedFormatRecipe.format.toUpperCase())} recipe for <code>${escapeHtml(loadedFormatRecipe.filename)}</code>. Approximate literal Babel depth: ${approximateDepthText(size)} levels. Saving regenerates the structured format instead of seeded garbage.</span><div class="xl-address mono">${escapeHtml(address)}</div>`;
    } else {
      target.innerHTML = `<strong>${formatBigBytes(size)}</strong> virtual object<br><span class="muted">Approximate literal Babel depth for an arbitrary object of this size: ${approximateDepthText(size)} levels. XL stores the generation recipe compactly instead.</span><div class="xl-address mono">${escapeHtml(address)}</div>`;
    }
  } catch (e) {
    target.innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

function parseAddress(address) {
  const raw = address.trim();
  const parts = raw.split(':');
  if (parts.length !== 4) throw new Error('Not a valid ICXL1 or ICFMT1 address.');

  const size = BigInt(parts[1]);
  if (size < 1n || size > MAX_BYTES) throw new Error('Recipe size is outside the supported 1 B–1 TiB range.');

  suppressRecipeReset = true;
  try {
    const [unit, multiplier] = chooseExactUnit(size);
    $('#xl-size').value = String(size / multiplier);
    $('#xl-unit').value = unit;

    if (parts[0] === 'ICXL1') {
      const mode = parts[2];
      if (!['zero','counter','text','seeded'].includes(mode)) throw new Error('Unknown XL mode in address.');
      loadedFormatRecipe = null;
      $('#xl-mode').value = mode;
      if (mode === 'text') $('#xl-pattern').value = base64urlDecode(parts[3]);
      if (mode === 'seeded') $('#xl-seed').value = base64urlDecode(parts[3]);
      updateModeUi();
      return { type: 'ICXL1', size };
    }

    if (parts[0] === 'ICFMT1') {
      const format = parts[2].toLowerCase();
      if (!FORMAT_TYPES.has(format)) throw new Error(`Unsupported ICFMT1 format: ${format}.`);
      let payload;
      try { payload = JSON.parse(base64urlDecode(parts[3])); }
      catch { throw new Error('ICFMT1 payload is not valid encoded JSON.'); }
      if (!payload || payload.format !== format || typeof payload.seed !== 'string') throw new Error('ICFMT1 payload is missing its format or seed.');
      const filename = typeof payload.filename === 'string' && payload.filename ? payload.filename : `corridor.${format === 'text' ? 'txt' : format}`;
      loadedFormatRecipe = { address: raw, size, format, seed: payload.seed, filename };
      $('#xl-mode').value = 'seeded';
      $('#xl-seed').value = payload.seed;
      $('#xl-filename').value = filename;
      updateModeUi();
      return { type: 'ICFMT1', size, format, filename };
    }

    throw new Error('Not a valid ICXL1 or ICFMT1 address.');
  } finally {
    suppressRecipeReset = false;
  }
}

async function copyAddress() {
  const address = currentAddress();
  await navigator.clipboard.writeText(address);
  $('#xl-status').textContent = `${address.startsWith('ICFMT1:') ? 'ICFMT1' : 'ICXL1'} address copied.`;
}

function u16le(n) { return Uint8Array.of(n & 255, (n >>> 8) & 255); }
function u32le(n) { return Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); }
function u32be(n) { return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function u64le(n) {
  let v = BigInt(n);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 255n); v >>= 8n; }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, bytes) {
  let c = crc >>> 0;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
function crc32Finish(crc) { return (crc ^ 0xffffffff) >>> 0; }
function crc32(bytes) { return crc32Finish(crc32Update(0xffffffff, bytes)); }

function concatBytes(...parts) {
  const arrays = parts.map(p => typeof p === 'string' ? encoder.encode(p) : p);
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function pngChunk(type, data) {
  const typeBytes = encoder.encode(type);
  return concatBytes(u32be(data.length), typeBytes, data, u32be(crc32(concatBytes(typeBytes, data))));
}

function createWriteState(total) {
  return { total, written: 0n, lastUi: performance.now() };
}

async function updateWriteUi(state, force = false) {
  const now = performance.now();
  if (!force && now - state.lastUi < 120) return;
  const pct = Number(state.written * 10000n / state.total) / 100;
  $('#xl-progress').value = pct;
  $('#xl-status').textContent = `${pct.toFixed(2)}% · ${formatBigBytes(state.written)} / ${formatBigBytes(state.total)}`;
  state.lastUi = now;
  await new Promise(requestAnimationFrame);
}

async function writeBytes(writable, bytes, state) {
  if (cancelRequested) throw new DOMException('Cancelled', 'AbortError');
  if (!bytes.length) return;
  await writable.write(bytes);
  state.written += BigInt(bytes.length);
  await updateWriteUi(state);
}

async function writeGenerated(writable, length, next, state, alphabet = null, crcState = null) {
  let remaining = BigInt(length);
  let crc = crcState;
  while (remaining > 0n) {
    if (cancelRequested) throw new DOMException('Cancelled', 'AbortError');
    const n = Number(remaining < BigInt(CHUNK_SIZE) ? remaining : BigInt(CHUNK_SIZE));
    const chunk = fillFromGenerator(n, next, alphabet);
    if (crc !== null) crc = crc32Update(crc, chunk);
    await writeBytes(writable, chunk, state);
    remaining -= BigInt(n);
  }
  return crc;
}

async function saveTextFormat(writable, total, recipe, state) {
  const alphabet = Uint8Array.from(encoder.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,_-'));
  const next = makeByteGenerator(recipe.seed);
  await writeGenerated(writable, total, next, state, alphabet);
}

async function saveJsonFormat(writable, total, recipe, state) {
  if (total < 2n) throw new Error('A valid JSON object needs at least 2 bytes.');
  await writeBytes(writable, encoder.encode('{}'), state);
  const next = makeByteGenerator(recipe.seed);
  const whitespace = Uint8Array.of(0x20, 0x09, 0x0a, 0x0d);
  await writeGenerated(writable, total - 2n, next, state, whitespace);
}

function buildPdfPrefix() {
  const header = '%PDF-1.4\n% Infinite Corridor\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ];
  let body = header;
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(encoder.encode(body).length);
    body += obj;
  }
  return { bytes: encoder.encode(body), offsets };
}

function buildPdfSuffix(offsets, xrefPos) {
  if (xrefPos > 9_999_999_999n) throw new Error('Classic PDF xref offsets exceed 10 digits above about 9.31 GiB; this format-aware PDF writer currently stops there.');
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  const tail = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return encoder.encode(xref + tail);
}

function solvePdfLayout(total) {
  const prefix = buildPdfPrefix();
  let filler = 0n;
  for (let i = 0; i < 16; i++) {
    const xrefPos = BigInt(prefix.bytes.length) + filler;
    const suffix = buildPdfSuffix(prefix.offsets, xrefPos);
    const nextFiller = total - BigInt(prefix.bytes.length + suffix.length);
    if (nextFiller < 0n) throw new Error(`Target is too small for a valid PDF. Minimum is about ${prefix.bytes.length + suffix.length} bytes.`);
    if (nextFiller === filler) return { prefix: prefix.bytes, filler, suffix };
    filler = nextFiller;
  }
  const xrefPos = BigInt(prefix.bytes.length) + filler;
  const suffix = buildPdfSuffix(prefix.offsets, xrefPos);
  if (BigInt(prefix.bytes.length + suffix.length) + filler !== total) throw new Error('Could not solve an exact PDF layout for this byte size.');
  return { prefix: prefix.bytes, filler, suffix };
}

async function savePdfFormat(writable, total, recipe, state) {
  const layout = solvePdfLayout(total);
  await writeBytes(writable, layout.prefix, state);
  const next = makeByteGenerator(recipe.seed);
  const whitespace = Uint8Array.of(0x20, 0x09, 0x0a, 0x0d);
  await writeGenerated(writable, layout.filler, next, state, whitespace);
  await writeBytes(writable, layout.suffix, state);
}

async function writeDynamicPngChunk(writable, type, dataLength, next, state) {
  if (dataLength > 0x7fffffffn) throw new Error('A single PNG chunk cannot exceed 2^31-1 bytes.');
  const typeBytes = encoder.encode(type);
  await writeBytes(writable, u32be(Number(dataLength)), state);
  await writeBytes(writable, typeBytes, state);
  let crc = crc32Update(0xffffffff, typeBytes);
  crc = await writeGenerated(writable, dataLength, next, state, null, crc);
  await writeBytes(writable, u32be(crc32Finish(crc)), state);
}

async function savePngFormat(writable, total, recipe, state) {
  const signature = Uint8Array.of(137,80,78,71,13,10,26,10);
  const ihdr = concatBytes(u32be(1), u32be(1), Uint8Array.of(8,6,0,0,0));
  const idat = Uint8Array.of(0x78,0x9c,0x63,0x60,0x00,0x02,0x00,0x00,0x05,0x00,0x01);
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const idatChunk = pngChunk('IDAT', idat);
  const iendChunk = pngChunk('IEND', new Uint8Array());
  const base = BigInt(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  if (total < base) throw new Error(`Target is too small for this valid PNG template. Minimum is ${base} bytes.`);
  let extra = total - base;
  if (extra > 0n && extra < 12n) throw new Error(`This exact PNG size is not representable by the current template; choose at least ${base + 12n} bytes or exactly ${base} bytes.`);

  await writeBytes(writable, signature, state);
  await writeBytes(writable, ihdrChunk, state);

  const next = makeByteGenerator(recipe.seed);
  const maxTotal = BigInt(PNG_STREAM_CHUNK_DATA + 12);
  while (extra > 0n) {
    let chunkTotal = extra > maxTotal ? maxTotal : extra;
    let after = extra - chunkTotal;
    if (after > 0n && after < 12n) {
      const shift = 12n - after;
      chunkTotal -= shift;
      after += shift;
    }
    if (chunkTotal < 12n) throw new Error('Unable to partition ancillary PNG chunks for this exact size.');
    await writeDynamicPngChunk(writable, 'raNd', chunkTotal - 12n, next, state);
    extra = after;
  }

  await writeBytes(writable, idatChunk, state);
  await writeBytes(writable, iendChunk, state);
}

async function saveZipFormat(writable, total, recipe, state) {
  const name = encoder.encode('content.bin');
  const overhead = BigInt(30 + name.length + 16 + 46 + name.length + 22);
  if (total < overhead) throw new Error(`Target is too small for the ZIP template. Minimum is ${overhead} bytes.`);
  const contentLength = total - overhead;
  const localHeaderLength = BigInt(30 + name.length);
  const centralOffset = localHeaderLength + contentLength + 16n;
  if (contentLength > 0xffffffffn || centralOffset > 0xffffffffn) {
    throw new Error('Format-aware ZIP currently uses ZIP32 and is capped below 4 GiB. ZIP64 generation is not implemented yet.');
  }
  const n = Number(contentLength);
  const local = concatBytes(
    Uint8Array.of(0x50,0x4b,0x03,0x04),
    u16le(20), u16le(0x0008), u16le(0), u16le(0), u16le(0),
    u32le(0), u32le(0), u32le(0), u16le(name.length), u16le(0), name
  );
  await writeBytes(writable, local, state);

  const next = makeByteGenerator(recipe.seed);
  let crc = 0xffffffff;
  crc = await writeGenerated(writable, contentLength, next, state, null, crc);
  const finalCrc = crc32Finish(crc);

  const descriptor = concatBytes(
    Uint8Array.of(0x50,0x4b,0x07,0x08), u32le(finalCrc), u32le(n), u32le(n)
  );
  await writeBytes(writable, descriptor, state);

  const central = concatBytes(
    Uint8Array.of(0x50,0x4b,0x01,0x02),
    u16le(20), u16le(20), u16le(0x0008), u16le(0), u16le(0), u16le(0),
    u32le(finalCrc), u32le(n), u32le(n),
    u16le(name.length), u16le(0), u16le(0), u16le(0), u16le(0),
    u32le(0), u32le(0), name
  );
  await writeBytes(writable, central, state);

  const eocd = concatBytes(
    Uint8Array.of(0x50,0x4b,0x05,0x06),
    u16le(0), u16le(0), u16le(1), u16le(1),
    u32le(central.length), u32le(Number(centralOffset)), u16le(0)
  );
  await writeBytes(writable, eocd, state);
}

function buildSafetensorsHeader(total) {
  let dataLength = total > 256n ? total - 256n : 0n;
  for (let i = 0; i < 20; i++) {
    const json = `{"data":{"dtype":"U8","shape":[${dataLength}],"data_offsets":[0,${dataLength}]}}`;
    const jsonBytes = encoder.encode(json);
    const headerLength = BigInt(Math.ceil(jsonBytes.length / 8) * 8);
    const nextDataLength = total - 8n - headerLength;
    if (nextDataLength < 0n) throw new Error('Target is too small for a valid Safetensors header.');
    if (nextDataLength === dataLength) {
      const header = new Uint8Array(Number(headerLength));
      header.fill(0x20);
      header.set(jsonBytes);
      return { header, dataLength };
    }
    dataLength = nextDataLength;
  }
  throw new Error('Could not stabilize Safetensors header sizing.');
}

async function saveSafetensorsFormat(writable, total, recipe, state) {
  const { header, dataLength } = buildSafetensorsHeader(total);
  await writeBytes(writable, u64le(header.length), state);
  await writeBytes(writable, header, state);
  const next = makeByteGenerator(recipe.seed);
  await writeGenerated(writable, dataLength, next, state);
}

async function saveGgufFormat(writable, total, recipe, state) {
  const key = encoder.encode('general.name');
  const fixed = BigInt(24 + 8 + key.length + 4 + 8);
  if (total < fixed) throw new Error(`Target is too small for the GGUF template. Minimum is ${fixed} bytes.`);
  const valueLength = total - fixed;
  const prefix = concatBytes(
    encoder.encode('GGUF'), u32le(3), u64le(0), u64le(1),
    u64le(key.length), key, u32le(8), u64le(valueLength)
  );
  await writeBytes(writable, prefix, state);
  const next = makeByteGenerator(recipe.seed);
  const printable = Uint8Array.from(encoder.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,_-'));
  await writeGenerated(writable, valueLength, next, state, printable);
}

async function saveFormatRecipe(writable, total, recipe, state) {
  if (total !== recipe.size) throw new Error('The ICFMT1 size no longer matches the loaded recipe.');
  if (recipe.format === 'text') return saveTextFormat(writable, total, recipe, state);
  if (recipe.format === 'json') return saveJsonFormat(writable, total, recipe, state);
  if (recipe.format === 'pdf') return savePdfFormat(writable, total, recipe, state);
  if (recipe.format === 'png') return savePngFormat(writable, total, recipe, state);
  if (recipe.format === 'zip') return saveZipFormat(writable, total, recipe, state);
  if (recipe.format === 'safetensors') return saveSafetensorsFormat(writable, total, recipe, state);
  if (recipe.format === 'gguf') return saveGgufFormat(writable, total, recipe, state);
  throw new Error(`No format-aware XL writer exists for ${recipe.format}.`);
}

async function saveNormalXl(writable, total, state) {
  const mode = $('#xl-mode').value;
  if (mode === 'zero' && $('#xl-fast-zero').checked) {
    await writable.truncate(Number(total));
    state.written = total;
    await updateWriteUi(state, true);
    return;
  }

  const template = makeTemplate(mode);
  let remaining = total;
  while (remaining > 0n) {
    if (cancelRequested) throw new DOMException('Cancelled', 'AbortError');
    const length = Number(remaining < BigInt(template.length) ? remaining : BigInt(template.length));
    await writeBytes(writable, length === template.length ? template : template.subarray(0, length), state);
    remaining -= BigInt(length);
  }
}

async function saveFile() {
  if (!window.showSaveFilePicker) {
    throw new Error('Large streamed saving needs the File System Access API. Use a Chromium-based desktop browser such as Chrome, Edge, or a compatible Opera build.');
  }
  const total = parseSize();
  const suggestedName = (($('#xl-filename').value.trim()) || loadedFormatRecipe?.filename || 'corridor-xl.bin').replace(/[\\/:*?"<>|]/g, '_');
  const handle = await window.showSaveFilePicker({ suggestedName });
  const writable = await handle.createWritable();
  cancelRequested = false;
  $('#xl-cancel').disabled = false;
  $('#xl-save').disabled = true;
  $('#xl-progress').value = 0;
  $('#xl-status').textContent = `Preparing ${formatBigBytes(total)}${loadedFormatRecipe ? ` ${loadedFormatRecipe.format.toUpperCase()}` : ''}...`;
  const state = createWriteState(total);

  try {
    if (loadedFormatRecipe) await saveFormatRecipe(writable, total, loadedFormatRecipe, state);
    else await saveNormalXl(writable, total, state);

    if (state.written !== total) throw new Error(`Generator wrote ${state.written} bytes but the recipe requires ${total}.`);
    await writable.close();
    $('#xl-progress').value = 100;
    $('#xl-status').textContent = `Finished writing ${formatBigBytes(total)}${loadedFormatRecipe ? ` structured ${loadedFormatRecipe.format.toUpperCase()}` : ''}.`;
  } catch (e) {
    try { await writable.abort(); } catch {}
    if (e?.name === 'AbortError') $('#xl-status').textContent = 'Generation cancelled; uncommitted changes were discarded where supported.';
    else throw e;
  } finally {
    $('#xl-cancel').disabled = true;
    $('#xl-save').disabled = false;
  }
}

$('#xl-mode').addEventListener('change', () => { clearFormatRecipe(); updateModeUi(); });
$('#xl-size').addEventListener('input', () => { clearFormatRecipe(); updateSummary(); });
$('#xl-unit').addEventListener('change', () => { clearFormatRecipe(); updateSummary(); });
$('#xl-pattern').addEventListener('input', () => { clearFormatRecipe(); updateSummary(); });
$('#xl-seed').addEventListener('input', () => { clearFormatRecipe(); updateSummary(); });
$('#xl-filename').addEventListener('input', () => { clearFormatRecipe(); updateSummary(); });

$('#xl-copy-address').addEventListener('click', () => copyAddress().catch(e => $('#xl-status').textContent = e.message));
$('#xl-load-address').addEventListener('click', () => {
  try {
    const parsed = parseAddress($('#xl-address-input').value);
    $('#xl-status').textContent = `${parsed.type}${parsed.format ? ` ${parsed.format.toUpperCase()}` : ''} address loaded.`;
  } catch (e) {
    $('#xl-status').textContent = e.message;
  }
});
$('#xl-save').addEventListener('click', () => saveFile().catch(e => {
  $('#xl-status').textContent = e.message;
  $('#xl-cancel').disabled = true;
  $('#xl-save').disabled = false;
}));
$('#xl-cancel').addEventListener('click', () => {
  cancelRequested = true;
  $('#xl-status').textContent = 'Cancelling...';
});

updateModeUi();
