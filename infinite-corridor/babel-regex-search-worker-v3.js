const MAX_MATERIAL_BYTES = 1024 * 1024;
const MAX_TOTAL_MATERIAL_BYTES = 32 * 1024 * 1024;
const HARD_MAX_BYTES = 1024 ** 4;
const HARD_REPEAT_CAP = 4096;
const HARD_BUDGET = 10_000_000;
const MAX_RESULTS = 500;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function regexParts(raw) {
  raw = String(raw || '').trim();
  if (!raw) throw new Error('Enter a filename regex.');
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/');
    if (last > 0) return { source: raw.slice(1, last), flags: raw.slice(last + 1).replace(/[gy]/g, '') };
  }
  return { source: raw, flags: '' };
}

class FilenameRegexParser {
  constructor(source, repeatCap) { this.s = source; this.i = 0; this.repeatCap = repeatCap; }
  parse() {
    const node = this.expression();
    if (this.i !== this.s.length) throw new Error(`Unexpected token near ${this.s.slice(this.i, this.i + 16)}`);
    return node;
  }
  expression(stop = '') {
    const alts = [this.sequence(stop)];
    while (this.s[this.i] === '|') { this.i++; alts.push(this.sequence(stop)); }
    return alts.length === 1 ? alts[0] : { t: 'alt', a: alts };
  }
  sequence(stop) {
    const items = [];
    while (this.i < this.s.length && this.s[this.i] !== stop && this.s[this.i] !== '|') items.push(this.quantified(this.atom()));
    return { t: 'seq', a: items };
  }
  atom() {
    const c = this.s[this.i++];
    if (c === '(') {
      if (this.s.slice(this.i, this.i + 2) === '?:') this.i += 2;
      else if (this.s[this.i] === '?') throw new Error('Lookarounds cannot be generatively enumerated. Rewrite the pattern without lookarounds.');
      const node = this.expression(')');
      if (this.s[this.i++] !== ')') throw new Error('Unclosed group.');
      return node;
    }
    if (c === '[') return { t: 'set', a: this.charClass() };
    if (c === '.') return { t: 'set', a: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.'] };
    if (c === '\\') return { t: 'set', a: this.escapeSet() };
    if (c === '^' || c === '$') return { t: 'lit', v: '' };
    if ('*+?{}'.includes(c)) throw new Error(`Quantifier ${c} has no target.`);
    if (c === undefined) throw new Error('Unexpected end of regex.');
    return { t: 'lit', v: c };
  }
  escapeSet() {
    const c = this.s[this.i++];
    if (c === 'd') return [...'0123456789'];
    if (c === 'w') return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'];
    if (c === 's') return [' ', '\t'];
    if (c === 'n') return ['\n'];
    if (c === 'r') return ['\r'];
    if (c === 't') return ['\t'];
    if (!c) throw new Error('Trailing escape.');
    if (/^[1-9]$/.test(c)) throw new Error('Backreferences cannot be generatively enumerated.');
    return [c];
  }
  charClass() {
    if (this.s[this.i] === '^') throw new Error('Negated character classes cannot be generatively enumerated safely.');
    const out = [];
    let first = true;
    while (this.i < this.s.length && (this.s[this.i] !== ']' || first)) {
      first = false;
      let start;
      if (this.s[this.i] === '\\') {
        this.i++;
        const set = this.escapeSet();
        if (set.length > 1) { out.push(...set); continue; }
        start = set[0];
      } else start = this.s[this.i++];
      if (this.s[this.i] === '-' && this.s[this.i + 1] !== ']') {
        this.i++;
        let end;
        if (this.s[this.i] === '\\') {
          this.i++;
          const set = this.escapeSet();
          if (set.length !== 1) throw new Error('Character-class range endpoint must be one character.');
          end = set[0];
        } else end = this.s[this.i++];
        for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code++) out.push(String.fromCharCode(code));
      } else out.push(start);
    }
    if (this.s[this.i++] !== ']') throw new Error('Unclosed character class.');
    if (!out.length) throw new Error('Empty character class.');
    return [...new Set(out)];
  }
  quantified(node) {
    const c = this.s[this.i];
    if (!c || !'*+?{'.includes(c)) return node;
    let min, max;
    if (c === '?') { this.i++; min = 0; max = 1; }
    else if (c === '*') { this.i++; min = 0; max = this.repeatCap; }
    else if (c === '+') { this.i++; min = 1; max = this.repeatCap; }
    else {
      this.i++;
      const m = this.s.slice(this.i).match(/^(\d+)(?:,(\d*)?)?\}/);
      if (!m) throw new Error('Invalid {m,n} quantifier.');
      this.i += m[0].length;
      min = Number(m[1]);
      max = m[0].includes(',') ? (m[2] ? Number(m[2]) : Math.max(min, this.repeatCap)) : min;
      if (min > HARD_REPEAT_CAP || max > HARD_REPEAT_CAP) throw new Error(`A single repetition is capped at ${HARD_REPEAT_CAP.toLocaleString()}.`);
    }
    if (max < min) throw new Error('Quantifier maximum is smaller than minimum.');
    return { t: 'rep', n: node, min, max };
  }
}

function pick(values) { return values[Math.floor(Math.random() * values.length)]; }
function biasedCount(min, max, mode) {
  if (max <= min) return min;
  const span = max - min;
  if (mode === 'max') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.28) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}
function generateName(node, mode) {
  if (node.t === 'lit') return node.v;
  if (node.t === 'set') return pick(node.a);
  if (node.t === 'seq') return node.a.map(x => generateName(x, mode)).join('');
  if (node.t === 'alt') return generateName(pick(node.a), mode);
  if (node.t === 'rep') {
    const n = biasedCount(node.min, node.max, mode);
    let out = '';
    for (let i = 0; i < n; i++) out += generateName(node.n, mode);
    return out;
  }
  return '';
}
function unescapeLiteral(text) { return text.replace(/\\([\\.^$|?*+(){}\[\]-])/g, '$1'); }
function detectSimpleNumericPattern(source) {
  const m = source.match(/^([^\[|()]*)\[0-9\]\{(\d+)\}([^\[|()]*)$/);
  if (!m) return null;
  const width = Number(m[2]);
  if (!Number.isInteger(width) || width < 1 || width > 15) return null;
  return { prefix: unescapeLiteral(m[1]), width, suffix: unescapeLiteral(m[3]) };
}
function chooseSize(min, max, mode) {
  if (max <= min) return min;
  const span = max - min;
  if (mode === 'max') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.25) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}
function estimatedDepth(byteLength) {
  if (!byteLength) return 0;
  return Math.ceil((byteLength * 8) / Math.log2(4900));
}
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h || 0x9e3779b9;
}
function seededByteGenerator(seed) {
  let x = fnv1a(seed);
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return x & 255; };
}
function fillDeterministicBytes(size, seed) {
  const out = new Uint8Array(size), next = seededByteGenerator(seed);
  for (let i = 0; i < size; i++) out[i] = next();
  return out;
}
function makeSeed(filename, size, ordinal) { return `babel-regex|${filename}|${size}|${ordinal}`; }
function base64urlEncode(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function extensionOf(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.safetensors')) return 'safetensors';
  const i = lower.lastIndexOf('.');
  return i >= 0 ? lower.slice(i + 1) : '';
}
function formatFromExtension(filename) {
  const ext = extensionOf(filename);
  if (['txt', 'log', 'md', 'csv'].includes(ext)) return 'text';
  if (ext === 'jpeg') return 'jpg';
  if (['m4a', 'mov'].includes(ext)) return 'mp4';
  if (ext === 'webm') return 'mkv';
  return ext || 'binary';
}

function concatBytes(...parts) {
  const arrays = parts.map(p => typeof p === 'string' ? encoder.encode(p) : p);
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function u16le(n) { return Uint8Array.of(n & 255, (n >>> 8) & 255); }
function u32le(n) { return Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); }
function u32be(n) { return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function u64le(n) {
  let v = BigInt(n); const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 255n); v >>= 8n; }
  return out;
}
function readU64le(bytes, offset) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function pngChunk(type, data) {
  const t = encoder.encode(type);
  return concatBytes(u32be(data.length), t, data, u32be(crc32(concatBytes(t, data))));
}
function zlibStore(raw) {
  const parts = [Uint8Array.of(0x78, 0x01)];
  let off = 0;
  while (off < raw.length) {
    const len = Math.min(65535, raw.length - off), final = off + len >= raw.length;
    parts.push(Uint8Array.of(final ? 0x01 : 0x00), u16le(len), u16le((~len) & 0xffff), raw.slice(off, off + len));
    off += len;
  }
  parts.push(u32be(adler32(raw)));
  return concatBytes(...parts);
}
function unzipStoredZlib(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0x78) throw new Error('Unsupported zlib stream');
  let off = 2; const parts = [];
  while (off < bytes.length - 4) {
    const header = bytes[off++], final = header & 1, type = (header >> 1) & 3;
    if (type !== 0) throw new Error('PNG content inspection supports stored DEFLATE blocks only');
    if (off + 4 > bytes.length) throw new Error('Truncated DEFLATE block');
    const len = bytes[off] | (bytes[off + 1] << 8), nlen = bytes[off + 2] | (bytes[off + 3] << 8); off += 4;
    if (((len ^ nlen) & 0xffff) !== 0xffff || off + len > bytes.length) throw new Error('Invalid DEFLATE stored block');
    parts.push(bytes.slice(off, off + len)); off += len;
    if (final) break;
  }
  return concatBytes(...parts);
}

const WORDS = ['archive','signal','corridor','document','record','vector','matrix','network','system','pattern','analysis','memory','index','object','content','search','structure','field','sequence','frame','layer','packet','source','target','version','result','model','sample','binary','format','reader','valid','metadata','segment','value','context','engine','browser','local','deterministic'];
function readableText(size, seed, filename = '') {
  if (size <= 0) return new Uint8Array();
  const next = seededByteGenerator(seed), parts = [];
  let total = 0;
  const add = text => { const bytes = encoder.encode(text); parts.push(bytes); total += bytes.length; };
  add(filename ? `Infinite Corridor candidate: ${filename}\n\n` : 'Infinite Corridor generated content\n\n');
  while (total < size) {
    const sentenceWords = 8 + (next() % 10);
    const words = [];
    for (let i = 0; i < sentenceWords; i++) {
      let w = WORDS[next() % WORDS.length];
      if (i === 0) w = w[0].toUpperCase() + w.slice(1);
      words.push(w);
    }
    add(words.join(' ') + '.\n');
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const part of parts) { if (off >= size) break; const n = Math.min(part.length, size - off); out.set(part.subarray(0, n), off); off += n; }
  return out;
}

function pdfSafe(text) { return String(text).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, m => '\\' + m); }
function buildRichPdf(size, seed, filename) {
  const safeName = pdfSafe(filename);
  const hash = fnv1a(seed).toString(16).padStart(8, '0');
  const c1 = `BT /F1 18 Tf 72 720 Td (Infinite Corridor generated candidate) Tj 0 -28 Td (${safeName}) Tj 0 -28 Td (Deterministic seed ${hash}) Tj 0 -40 Td (This page contains visible text and vector content.) Tj ET\n0 0 0 RG 2 w 72 560 468 90 re S\n72 580 m 540 630 l S\n`;
  const c2 = `BT /F1 14 Tf 72 720 Td (Generated content inspection page two) Tj 0 -24 Td (Archive signal corridor document record vector matrix network.) Tj 0 -24 Td (System pattern analysis memory index object content search.) Tj 0 -24 Td (Structure field sequence frame layer packet source target.) Tj ET\n0 0 0 RG 1 w 72 600 m 540 600 l 540 500 l 72 500 l h S\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${encoder.encode(c1).length} >>\nstream\n${c1}endstream\nendobj\n`,
    `5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n`,
    `6 0 obj\n<< /Length ${encoder.encode(c2).length} >>\nstream\n${c2}endstream\nendobj\n`,
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  function build(fillerLen) {
    let body = '%PDF-1.4\n% Infinite Corridor content-rich candidate\n';
    const offsets = [0];
    for (const obj of objects) { offsets.push(encoder.encode(body).length); body += obj; }
    if (fillerLen > 0) body += ' '.repeat(fillerLen);
    const xrefPos = encoder.encode(body).length;
    let xref = 'xref\n0 8\n0000000000 65535 f \n';
    for (let i = 1; i <= 7; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    return encoder.encode(body + xref + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  }
  let base = build(0);
  if (base.length > size) return null;
  let filler = size - base.length;
  for (let i = 0; i < 12; i++) {
    const bytes = build(filler), diff = size - bytes.length;
    if (diff === 0) return bytes;
    filler += diff;
    if (filler < 0) return null;
  }
  const bytes = build(filler);
  return bytes.length === size ? bytes : null;
}

function makeRichPng(size, seed, filename, contentRequirement) {
  const dims = contentRequirement === 'rich' ? [48, 40, 32] : [32, 24, 16];
  for (const dim of dims) {
    const width = dim, height = dim, raw = new Uint8Array(height * (1 + width * 4)), next = seededByteGenerator(seed);
    let p = 0;
    for (let y = 0; y < height; y++) {
      raw[p++] = 0;
      for (let x = 0; x < width; x++) {
        raw[p++] = (x * 7 + next()) & 255;
        raw[p++] = (y * 11 + next()) & 255;
        raw[p++] = ((x + y) * 13 + next()) & 255;
        raw[p++] = 255;
      }
    }
    const signature = Uint8Array.of(137,80,78,71,13,10,26,10);
    const ihdr = concatBytes(u32be(width), u32be(height), Uint8Array.of(8,6,0,0,0));
    const text = encoder.encode(`Title\0Infinite Corridor ${String(filename).slice(0, 120)}`);
    const idat = zlibStore(raw);
    const fixed = concatBytes(signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', text), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array()));
    if (fixed.length === size) return fixed;
    const extra = size - fixed.length;
    if (extra >= 12) {
      const pad = fillDeterministicBytes(extra - 12, seed + '|png-pad');
      return concatBytes(signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', text), pngChunk('raNd', pad), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array()));
    }
  }
  return null;
}

function makeRichJson(size, seed, filename) {
  const obj = {
    title: 'Infinite Corridor candidate',
    filename,
    seed: fnv1a(seed).toString(16).padStart(8, '0'),
    items: WORDS.slice(0, 8).map((word, i) => ({ id: i + 1, value: word, active: i % 2 === 0 })),
    metadata: { generated: true, contentProfile: 'nontrivial-v1' }
  };
  const base = encoder.encode(JSON.stringify(obj));
  if (base.length > size) return null;
  const out = new Uint8Array(size); out.set(base); out.fill(0x20, base.length); return out;
}
function makeRichText(size, seed, filename) { return readableText(size, seed, filename); }
function makeRichZip(size, seed, filename) {
  const name = encoder.encode('document.txt');
  const overhead = 30 + name.length + 46 + name.length + 22;
  const contentLength = size - overhead;
  if (contentLength < 64) return null;
  const content = readableText(contentLength, seed, filename), crc = crc32(content);
  const local = concatBytes(Uint8Array.of(0x50,0x4b,0x03,0x04),u16le(20),u16le(0),u16le(0),u16le(0),u16le(0),u32le(crc),u32le(contentLength),u32le(contentLength),u16le(name.length),u16le(0),name,content);
  const central = concatBytes(Uint8Array.of(0x50,0x4b,0x01,0x02),u16le(20),u16le(20),u16le(0),u16le(0),u16le(0),u16le(0),u32le(crc),u32le(contentLength),u32le(contentLength),u16le(name.length),u16le(0),u16le(0),u16le(0),u16le(0),u32le(0),u32le(0),name);
  const eocd = concatBytes(Uint8Array.of(0x50,0x4b,0x05,0x06),u16le(0),u16le(0),u16le(1),u16le(1),u32le(central.length),u32le(local.length),u16le(0));
  return concatBytes(local, central, eocd);
}
function makeRichSafetensors(size, seed) {
  if (size < 80) return null;
  let dataLength = size - 80;
  for (let i = 0; i < 16; i++) {
    const json = JSON.stringify({ data: { dtype: 'U8', shape: [dataLength], data_offsets: [0, dataLength] }, __metadata__: { source: 'Infinite Corridor' } });
    const jsonBytes = encoder.encode(json), headerLen = Math.ceil(jsonBytes.length / 8) * 8, nextDataLength = size - 8 - headerLen;
    if (nextDataLength < 1) return null;
    if (nextDataLength === dataLength) {
      const header = new Uint8Array(headerLen); header.fill(0x20); header.set(jsonBytes);
      return concatBytes(u64le(headerLen), header, fillDeterministicBytes(dataLength, seed + '|tensor'));
    }
    dataLength = nextDataLength;
  }
  return null;
}
function makeMetadataGguf(size, seed) {
  const key = encoder.encode('general.name'), fixed = 24 + 8 + key.length + 4 + 8, valueLength = size - fixed;
  if (valueLength < 1) return null;
  const value = readableText(valueLength, seed);
  return concatBytes(encoder.encode('GGUF'),u32le(3),u64le(0),u64le(1),u64le(key.length),key,u32le(8),u64le(value.length),value);
}
function generateFormatAwareBytes(filename, size, seed, contentRequirement) {
  const format = formatFromExtension(filename);
  let bytes = null;
  if (format === 'pdf') bytes = buildRichPdf(size, seed, filename);
  else if (format === 'png') bytes = makeRichPng(size, seed, filename, contentRequirement);
  else if (format === 'json') bytes = makeRichJson(size, seed, filename);
  else if (format === 'text') bytes = makeRichText(size, seed, filename);
  else if (format === 'zip') bytes = makeRichZip(size, seed, filename);
  else if (format === 'safetensors') bytes = makeRichSafetensors(size, seed);
  else if (format === 'gguf') bytes = makeMetadataGguf(size, seed);
  return bytes ? { format, bytes } : null;
}

const magic = {
  pdf:encoder.encode('%PDF-'), png:Uint8Array.of(137,80,78,71,13,10,26,10), zip:Uint8Array.of(0x50,0x4b,0x03,0x04),
  jpg:Uint8Array.of(0xff,0xd8,0xff), gif:encoder.encode('GIF8'), '7z':Uint8Array.of(0x37,0x7a,0xbc,0xaf,0x27,0x1c),
  rar:encoder.encode('Rar!'), flac:encoder.encode('fLaC'), gguf:encoder.encode('GGUF'), sqlite:encoder.encode('SQLite format 3\0'),
  exe:encoder.encode('MZ'), dll:encoder.encode('MZ'), elf:Uint8Array.of(0x7f,0x45,0x4c,0x46), mkv:Uint8Array.of(0x1a,0x45,0xdf,0xa3)
};
function startsWithBytes(bytes, prefix) { if (!prefix || bytes.length < prefix.length) return false; for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false; return true; }
function endsWithAsciiTrimmed(bytes, text) {
  let end = bytes.length; while (end && [0x20,0x09,0x0a,0x0d].includes(bytes[end - 1])) end--;
  const n = encoder.encode(text); if (end < n.length) return false;
  for (let i = 0; i < n.length; i++) if (bytes[end - n.length + i] !== n[i]) return false;
  return true;
}
function contentResult(score, nontrivial, rich, details) { return { contentScore: score, contentNontrivial: nontrivial, contentRich: rich, contentDetails: details }; }
function validatePdf(bytes) {
  if (!startsWithBytes(bytes, magic.pdf)) return { recognizable:false,valid:false,strict:false,score:0,details:'Missing %PDF- header',...contentResult(0,false,false,'No PDF content') };
  const text = decoder.decode(bytes), hasObj = /\sobj\b/.test(text) && text.includes('endobj'), hasXref = text.includes('xref'), hasTrailer = text.includes('trailer'), hasStart = text.includes('startxref'), eof = endsWithAsciiTrimmed(bytes, '%%EOF');
  let strict = false;
  const m = text.match(/startxref\s+(\d+)\s+%%EOF\s*$/s);
  if (m) { const off = Number(m[1]); strict = Number.isInteger(off) && off >= 0 && off + 4 <= bytes.length && decoder.decode(bytes.slice(off, off + 4)) === 'xref'; }
  const valid = hasObj && hasXref && hasTrailer && hasStart && eof;
  const pages = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  const visible = [...text.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj\b/g)].map(x => x[1]).join(' ').replace(/\\[()\\]/g, '');
  const vectorOps = (text.match(/\b(?:re|m|l|S)\b/g) || []).length;
  const chars = visible.replace(/\s+/g, '').length;
  const rich = valid && pages >= 2 && chars >= 120 && vectorOps >= 4;
  const nontrivial = valid && pages >= 1 && chars >= 24;
  const cscore = rich ? 100 : nontrivial ? 80 : chars > 0 ? 45 : 0;
  return { recognizable:true,valid,strict:valid&&strict,score:strict&&valid?100:valid?90:35,details:strict&&valid?'PDF structure and xref validated':valid?'PDF structure present':'PDF structure incomplete',...contentResult(cscore,nontrivial,rich,`${pages} page(s), ${chars} visible text characters, ${vectorOps} drawing operators`) };
}
function validatePng(bytes) {
  if (!startsWithBytes(bytes, magic.png)) return { recognizable:false,valid:false,strict:false,score:0,details:'Missing PNG signature',...contentResult(0,false,false,'No PNG content') };
  let off = 8, width = 0, height = 0, ihdr = false, iend = false, crcOk = true; const idats = [];
  try {
    while (off + 12 <= bytes.length) {
      const len = ((bytes[off]<<24)|(bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3]) >>> 0;
      if (off + 12 + len > bytes.length) throw new Error('Truncated chunk');
      const typeBytes = bytes.slice(off+4,off+8), type = decoder.decode(typeBytes), data = bytes.slice(off+8,off+8+len), expected = ((bytes[off+8+len]<<24)|(bytes[off+9+len]<<16)|(bytes[off+10+len]<<8)|bytes[off+11+len]) >>> 0;
      if (crc32(concatBytes(typeBytes, data)) !== expected) crcOk = false;
      if (type === 'IHDR' && len === 13) { width = ((data[0]<<24)|(data[1]<<16)|(data[2]<<8)|data[3])>>>0; height = ((data[4]<<24)|(data[5]<<16)|(data[6]<<8)|data[7])>>>0; ihdr = width > 0 && height > 0; }
      if (type === 'IDAT') idats.push(data);
      off += 12 + len;
      if (type === 'IEND') { iend = len === 0; break; }
    }
  } catch (e) { return { recognizable:true,valid:false,strict:false,score:30,details:e.message,...contentResult(0,false,false,'Could not inspect pixel data') }; }
  const valid = ihdr && idats.length > 0 && iend, strict = valid && crcOk && off === bytes.length;
  let distinct = 0;
  try {
    const raw = unzipStoredZlib(concatBytes(...idats)), colors = new Set();
    const stride = 1 + width * 4;
    if (raw.length >= stride * height) {
      const stepX = Math.max(1, Math.floor(width / 32)), stepY = Math.max(1, Math.floor(height / 32));
      for (let y = 0; y < height; y += stepY) for (let x = 0; x < width; x += stepX) {
        const p = y * stride + 1 + x * 4; colors.add(`${raw[p]},${raw[p+1]},${raw[p+2]},${raw[p+3]}`);
      }
      distinct = colors.size;
    }
  } catch {}
  const pixels = width * height, rich = valid && pixels >= 1024 && distinct >= 16, nontrivial = valid && pixels >= 256 && distinct >= 4, cscore = rich ? 100 : nontrivial ? 80 : pixels > 1 && distinct > 1 ? 45 : 0;
  return { recognizable:true,valid,strict,score:strict?100:valid?85:35,details:strict?'PNG chunks and CRCs valid':valid?'Required PNG chunks found':'PNG structure incomplete',...contentResult(cscore,nontrivial,rich,`${width}×${height} pixels, ${distinct || 'unknown'} sampled distinct colors`) };
}
function validateZip(bytes) {
  if (!startsWithBytes(bytes, magic.zip) || bytes.length < 30) return { recognizable:false,valid:false,strict:false,score:0,details:'Missing ZIP header',...contentResult(0,false,false,'No ZIP content') };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), crc = dv.getUint32(14,true), size = dv.getUint32(18,true), nameLen = dv.getUint16(26,true), extraLen = dv.getUint16(28,true), start = 30 + nameLen + extraLen;
  let eocd = -1; for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 4; i++) if (bytes[i]===0x50&&bytes[i+1]===0x4b&&bytes[i+2]===0x05&&bytes[i+3]===0x06) eocd = i;
  const inBounds = start + size <= bytes.length, payload = inBounds ? bytes.slice(start, start + size) : new Uint8Array(), crcOk = inBounds && crc32(payload) === crc, valid = eocd >= 0 && inBounds, strict = valid && crcOk;
  let printable = 0; if (payload.length) { const sample = payload.slice(0, Math.min(payload.length, 8192)); printable = [...sample].filter(x => x===9||x===10||x===13||(x>=32&&x<127)).length / sample.length; }
  const rich = strict && payload.length >= 256 && printable >= .9, nontrivial = strict && payload.length >= 32, cscore = rich ? 100 : nontrivial ? 80 : payload.length ? 45 : 0;
  return { recognizable:true,valid,strict,score:strict?100:valid?85:35,details:strict?'ZIP structure and stored-file CRC validated':valid?'ZIP structure found':'ZIP structure incomplete',...contentResult(cscore,nontrivial,rich,`${payload.length} payload bytes, ${(printable*100).toFixed(1)}% printable sample`) };
}
function analyzeJson(value) {
  let keys = 0, scalars = 0, arrays = 0, textChars = 0;
  function walk(v) {
    if (Array.isArray(v)) { arrays++; for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') { for (const [k,x] of Object.entries(v)) { keys++; textChars += k.length; walk(x); } return; }
    scalars++; textChars += String(v).length;
  }
  walk(value); return { keys, scalars, arrays, textChars };
}
function validateJson(bytes) {
  try {
    const obj = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)), a = analyzeJson(obj), rich = a.keys >= 6 && a.arrays >= 1 && a.scalars >= 8 && a.textChars >= 80, nontrivial = a.keys >= 2 && a.scalars >= 2, cscore = rich?100:nontrivial?80:a.keys?45:0;
    return { recognizable:true,valid:true,strict:true,score:100,details:'UTF-8 JSON parsed successfully',...contentResult(cscore,nontrivial,rich,`${a.keys} keys, ${a.scalars} scalar values, ${a.arrays} arrays`) };
  } catch { return { recognizable:false,valid:false,strict:false,score:0,details:'JSON parse failed',...contentResult(0,false,false,'JSON could not be parsed') }; }
}
function validateText(bytes) {
  try {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes), sample = [...text.slice(0, 65536)], good = sample.filter(c => c==='\n'||c==='\r'||c==='\t'||c.charCodeAt(0)>=32).length, ratio = sample.length ? good/sample.length : 1, words = (text.match(/[A-Za-z]{3,}/g)||[]).length, valid = ratio >= .9, rich = valid && words >= 100, nontrivial = valid && words >= 20, cscore = rich?100:nontrivial?80:words>=5?45:0;
    return { recognizable:valid,valid,strict:valid&&ratio>=.98,score:Math.round(ratio*100),details:`UTF-8 printable ratio ${(ratio*100).toFixed(1)}%`,...contentResult(cscore,nontrivial,rich,`${words} alphabetic words`) };
  } catch { return { recognizable:false,valid:false,strict:false,score:0,details:'Invalid UTF-8 text',...contentResult(0,false,false,'Text decoding failed') }; }
}
function validateSafetensors(bytes) {
  if (bytes.length < 10) return { recognizable:false,valid:false,strict:false,score:0,details:'Too small for Safetensors',...contentResult(0,false,false,'No tensor data') };
  const len = readU64le(bytes,0); if (len > BigInt(bytes.length-8) || len > BigInt(Number.MAX_SAFE_INTEGER)) return { recognizable:false,valid:false,strict:false,score:10,details:'Invalid Safetensors header length',...contentResult(0,false,false,'Invalid tensor header') };
  try {
    const obj = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(8,8+Number(len)))), dataBytes = bytes.length - 8 - Number(len), tensors = Object.entries(obj).filter(([k,v]) => k !== '__metadata__' && v && typeof v === 'object' && Array.isArray(v.data_offsets));
    let bounds = true; for (const [,v] of tensors) { const [a,b]=v.data_offsets; if (!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<a||b>dataBytes) bounds=false; }
    const valid = tensors.length>0 && bounds, rich = valid && dataBytes>=256, nontrivial=valid&&dataBytes>0, cscore=rich?100:nontrivial?80:0;
    return { recognizable:true,valid,strict:valid,score:valid?100:40,details:valid?'Safetensors tensor header and offsets validated':'Safetensors header lacks valid tensor data',...contentResult(cscore,nontrivial,rich,`${tensors.length} tensor(s), ${dataBytes} data bytes`) };
  } catch { return { recognizable:false,valid:false,strict:false,score:0,details:'Safetensors header parse failed',...contentResult(0,false,false,'Tensor metadata could not be parsed') }; }
}
function validateGguf(bytes) {
  if (!startsWithBytes(bytes,magic.gguf)||bytes.length<24) return { recognizable:false,valid:false,strict:false,score:0,details:'Missing or truncated GGUF header',...contentResult(0,false,false,'No GGUF tensors') };
  const dv = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), version=dv.getUint32(4,true), tensors=readU64le(bytes,8), kv=readU64le(bytes,16), valid=(version===2||version===3);
  const nontrivial = valid && tensors>0n, rich = nontrivial && tensors>=2n, cscore=rich?100:nontrivial?80:20;
  return { recognizable:true,valid,strict:valid,score:valid?90:30,details:valid?`GGUF v${version} header recognized`:`Unsupported GGUF version ${version}`,...contentResult(cscore,nontrivial,rich,`${tensors} tensor(s), ${kv} metadata entr${kv===1n?'y':'ies'}`) };
}
function validateGeneric(bytes,format) {
  if (format==='mp4') { const ok=bytes.length>=12&&decoder.decode(bytes.slice(4,8))==='ftyp'; return {recognizable:ok,valid:ok,strict:false,score:ok?65:0,details:ok?'ISO BMFF ftyp recognized':'Missing ftyp',...contentResult(0,false,false,'Media payload not decoded for content inspection')}; }
  if (format==='mp3') { const ok=startsWithBytes(bytes,encoder.encode('ID3'))||(bytes.length>=2&&bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0); return {recognizable:ok,valid:ok,strict:false,score:ok?60:0,details:ok?'MP3 signature recognized':'Missing MP3 signature',...contentResult(0,false,false,'Audio payload not decoded for content inspection')}; }
  const ok=magic[format]?startsWithBytes(bytes,magic[format]):false;
  return {recognizable:ok,valid:false,strict:false,score:ok?45:0,details:ok?`${format.toUpperCase()} signature recognized`:`No supported ${format.toUpperCase()} structure validator`,...contentResult(0,false,false,'No content inspector for this format')};
}
function validateCandidate(bytes,filename) {
  const format=formatFromExtension(filename); let v;
  if(format==='pdf')v=validatePdf(bytes);else if(format==='png')v=validatePng(bytes);else if(format==='zip')v=validateZip(bytes);else if(format==='json')v=validateJson(bytes);else if(format==='text')v=validateText(bytes);else if(format==='safetensors')v=validateSafetensors(bytes);else if(format==='gguf')v=validateGguf(bytes);else v=validateGeneric(bytes,format);
  return {format,...v};
}
function passesValidation(v,level,minScore) { if(v.score<minScore)return false;if(level==='any')return true;if(level==='signature')return v.recognizable;if(level==='readable')return v.valid;if(level==='strict')return v.strict;return true; }
function passesContent(v,requirement,minScore) { if(v.contentScore<minScore)return false;if(requirement==='any')return true;if(requirement==='nontrivial')return v.contentNontrivial;if(requirement==='rich')return v.contentRich;return true; }
function makeVirtualRecipe(filename,size,ordinal,strategy,format) {
  const seed=makeSeed(filename,size,ordinal);
  if(strategy==='format'&&['pdf','png','zip','json','text','safetensors','gguf'].includes(format)){
    const payload=base64urlEncode(JSON.stringify({format,seed,filename,profile:'content-v1'}));
    return{seed,address:`ICFMT1:${size}:${format}:${payload}`};
  }
  return{seed,address:`ICXL1:${size}:seeded:${base64urlEncode(seed)}`};
}
function virtualValidation(format,strategy) {
  const known=strategy==='format'&&['pdf','png','zip','json','text','safetensors','gguf'].includes(format);
  return {format,recognizable:known,valid:known,strict:false,score:known?80:0,details:known?'Format-aware virtual recipe; bytes are not materialized in this search worker.':'Large seeded bytes are not materialized.',...contentResult(0,false,false,'Content quality is not claimed without materializing the candidate')};
}

async function runSearch(settings) {
  const { raw, count, budget, minBytes, maxBytes, mode, validationLevel, strategy, minValidationScore, contentRequirement, minContentScore, repeatCap, numericStart } = settings;
  const {source,flags}=regexParts(raw),ast=new FilenameRegexParser(source,repeatCap).parse(),nameValidator=new RegExp(`^(?:${source})$`,flags.replace(/[gy]/g,'')),simpleNumeric=detectSimpleNumericPattern(source),numericLimit=simpleNumeric?10**simpleNumeric.width:0;
  if(minBytes>maxBytes)throw new Error('Minimum bytes cannot be larger than maximum bytes.');
  const needsInspection=validationLevel==='strict'||contentRequirement!=='any'||minContentScore>0;
  let effectiveMax=maxBytes;
  if(needsInspection) effectiveMax=Math.min(effectiveMax,MAX_MATERIAL_BYTES);
  if(minBytes>effectiveMax) throw new Error(`Strict/content inspection materializes candidates up to ${MAX_MATERIAL_BYTES.toLocaleString()} bytes (1 MiB). Lower Minimum bytes or use Any content with non-strict validation for larger virtual candidates.`);
  const note=effectiveMax<maxBytes?`Inspection range was clamped from ${maxBytes.toLocaleString()} to ${effectiveMax.toLocaleString()} bytes so validation can inspect actual bytes.`:'';
  postMessage({type:'meta',effectiveMax,note});

  const seen=new Set(); let attempts=0,accepted=0,rejected=0,totalMaterialBytes=0,lastProgress=performance.now(),batch=[];
  function flush(){if(!batch.length)return;const transfers=batch.filter(x=>x.buffer).map(x=>x.buffer);postMessage({type:'batch',items:batch,attempts,accepted,rejected},transfers);batch=[];}
  while(attempts<budget&&accepted<count){
    let filename;
    if(simpleNumeric){const n=(numericStart+attempts)%numericLimit;filename=`${simpleNumeric.prefix}${String(n).padStart(simpleNumeric.width,'0')}${simpleNumeric.suffix}`;}else filename=generateName(ast,mode);
    attempts++;
    nameValidator.lastIndex=0;if(!nameValidator.test(filename)){rejected++;continue;}
    const size=chooseSize(minBytes,effectiveMax,mode),key=`${filename}\0${size}`;if(seen.has(key)){rejected++;continue;}seen.add(key);
    const ordinal=attempts-1,seed=makeSeed(filename,size,ordinal),format=formatFromExtension(filename);
    if(size<=MAX_MATERIAL_BYTES){
      let bytes;
      if(strategy==='format'){const generated=generateFormatAwareBytes(filename,size,seed,contentRequirement);if(!generated){rejected++;continue;}bytes=generated.bytes;}else bytes=fillDeterministicBytes(size,seed);
      const validation=validateCandidate(bytes,filename);
      if(!passesValidation(validation,validationLevel,minValidationScore)||!passesContent(validation,contentRequirement,minContentScore)){rejected++;continue;}
      if(totalMaterialBytes+bytes.length>MAX_TOTAL_MATERIAL_BYTES){flush();throw new Error(`Accepted materialized results would exceed the ${Math.round(MAX_TOTAL_MATERIAL_BYTES/1024/1024)} MiB in-memory result budget. Reduce Results or maximum bytes.`);}
      totalMaterialBytes+=bytes.length;accepted++;
      const buffer=bytes.buffer;
      batch.push({kind:'materialized',filename,size,depth:estimatedDepth(size),validation,ordinal,buffer});
    } else {
      const validation=virtualValidation(format,strategy);
      if(!passesValidation(validation,validationLevel,minValidationScore)||!passesContent(validation,contentRequirement,minContentScore)){rejected++;continue;}
      const recipe=makeVirtualRecipe(filename,size,ordinal,strategy,format);accepted++;
      batch.push({kind:'virtual',filename,size,depth:estimatedDepth(size),validation,ordinal,recipe:recipe.address});
    }
    if(batch.length>=8)flush();
    const now=performance.now();
    if(now-lastProgress>60){flush();postMessage({type:'progress',attempts,accepted,rejected});lastProgress=now;await new Promise(r=>setTimeout(r,0));}
  }
  flush();
  postMessage({type:'done',attempts,accepted,rejected,note,totalMaterialBytes});
}

onmessage=event=>{
  const msg=event.data||{};
  if(msg.type!=='start')return;
  const s=msg.settings||{};
  const settings={
    raw:String(s.raw||''),
    count:Math.min(MAX_RESULTS,Math.max(1,Number(s.count)||100)),
    budget:Math.min(HARD_BUDGET,Math.max(1,Number(s.budget)||5000)),
    minBytes:Math.max(0,Math.min(HARD_MAX_BYTES,Number(s.minBytes)||0)),
    maxBytes:Math.max(1,Math.min(HARD_MAX_BYTES,Number(s.maxBytes)||65536)),
    mode:['deep','max','balanced'].includes(s.mode)?s.mode:'deep',
    validationLevel:['any','signature','readable','strict'].includes(s.validationLevel)?s.validationLevel:'readable',
    strategy:s.strategy==='random'?'random':'format',
    minValidationScore:Math.max(0,Math.min(100,Number(s.minValidationScore)||0)),
    contentRequirement:['any','nontrivial','rich'].includes(s.contentRequirement)?s.contentRequirement:'nontrivial',
    minContentScore:Math.max(0,Math.min(100,Number(s.minContentScore)||0)),
    repeatCap:Math.max(1,Math.min(HARD_REPEAT_CAP,Number(s.repeatCap)||256)),
    numericStart:Math.max(0,Number(s.numericStart)||0)
  };
  runSearch(settings).catch(error=>postMessage({type:'error',message:error?.message||String(error)}));
};
