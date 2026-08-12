import { bytesToPath, normalizePath, estimatedDepth, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const MAX_LITERAL_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 1024 ** 4; // 1 TiB
const HARD_REPEAT_CAP = 4096;
const HARD_BUDGET = 10_000_000;
const MAX_RESULTS = 500;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let currentResults = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function base64urlEncode(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function regexParts(raw) {
  raw = raw.trim();
  if (!raw) throw new Error('Enter a filename regex.');
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/');
    if (last > 0) return { source: raw.slice(1, last), flags: raw.slice(last + 1).replace(/[gy]/g, '') };
  }
  return { source: raw, flags: '' };
}

class FilenameRegexParser {
  constructor(source, repeatCap) {
    this.s = source;
    this.i = 0;
    this.repeatCap = repeatCap;
  }
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
    const count = biasedCount(node.min, node.max, mode);
    let out = '';
    for (let i = 0; i < count; i++) out += generateName(node.n, mode);
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

function fnv1a(text) {
  const bytes = encoder.encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h || 0x9e3779b9;
}
function seededByteGenerator(seedText) {
  let x = fnv1a(seedText);
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x & 0xff;
  };
}
function fillDeterministicBytes(size, seedText) {
  const out = new Uint8Array(size);
  const next = seededByteGenerator(seedText);
  for (let i = 0; i < out.length; i++) out[i] = next();
  return out;
}
function fillPrintable(size, seedText) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,_-';
  const next = seededByteGenerator(seedText);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = chars.charCodeAt(next() % chars.length);
  return out;
}
function chooseSize(min, max, mode) {
  if (max <= min) return min;
  const span = max - min;
  if (mode === 'max') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.25) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}
function makeSeed(filename, size, ordinal) { return `babel-regex|${filename}|${size}|${ordinal}`; }
function extensionOf(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.safetensors')) return 'safetensors';
  const i = lower.lastIndexOf('.');
  return i >= 0 ? lower.slice(i + 1) : '';
}
function formatFromExtension(filename) {
  const ext = extensionOf(filename);
  if (['txt','log','md','csv'].includes(ext)) return 'text';
  if (ext === 'jpeg') return 'jpg';
  if (['m4a','mov'].includes(ext)) return 'mp4';
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
function u32be(n) { return Uint8Array.of((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255); }
function u16le(n) { return Uint8Array.of(n&255,(n>>>8)&255); }
function u32le(n) { return Uint8Array.of(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255); }
function u64le(n) {
  let v = BigInt(n);
  const out = new Uint8Array(8);
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
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = encoder.encode(type);
  return concatBytes(u32be(data.length), typeBytes, data, u32be(crc32(concatBytes(typeBytes, data))));
}

function makeTextBytes(size, seed) { return fillPrintable(size, seed); }
function makeJsonBytes(size, seed) {
  if (size < 2) return null;
  const out = new Uint8Array(size);
  out[0] = 0x7b; out[1] = 0x7d;
  const whitespace = [0x20, 0x09, 0x0a, 0x0d];
  const next = seededByteGenerator(seed);
  for (let i = 2; i < size; i++) out[i] = whitespace[next() % whitespace.length];
  return out;
}
function buildPdfWithFiller(fillerLength, seed) {
  const header = '%PDF-1.4\n% Infinite Corridor\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n'
  ];
  let body = header;
  const offsets = [0];
  for (const obj of objects) { offsets.push(encoder.encode(body).length); body += obj; }
  if (fillerLength > 0) body += `%${decoder.decode(fillPrintable(fillerLength, seed))}\n`;
  const xrefPos = encoder.encode(body).length;
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) xref += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  const tail = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return encoder.encode(body + xref + tail);
}
function makePdfBytes(size, seed) {
  let bytes = buildPdfWithFiller(0, seed);
  if (bytes.length > size) return null;
  let filler = Math.max(0, size - bytes.length - 2);
  for (let i = 0; i < 8; i++) {
    bytes = buildPdfWithFiller(filler, seed);
    const diff = size - bytes.length;
    if (diff === 0) return bytes;
    filler += diff;
    if (filler < 0) return null;
  }
  return bytes.length === size ? bytes : null;
}
function makePngBytes(size, seed) {
  const signature = Uint8Array.of(137,80,78,71,13,10,26,10);
  const ihdr = concatBytes(u32be(1), u32be(1), Uint8Array.of(8,6,0,0,0));
  const idat = Uint8Array.from([0x78,0x9c,0x63,0x60,0x00,0x02,0x00,0x00,0x05,0x00,0x01]);
  const base = concatBytes(signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array()));
  if (size === base.length) return base;
  const dataLength = size - base.length - 12;
  if (dataLength < 2) return null;
  const textData = new Uint8Array(dataLength);
  textData[0] = 0x43; textData[1] = 0;
  if (dataLength > 2) textData.set(fillPrintable(dataLength - 2, seed), 2);
  return concatBytes(signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', textData), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array()));
}
function makeZipBytes(size, seed) {
  const name = encoder.encode('content.bin');
  const overhead = 30 + name.length + 46 + name.length + 22;
  const contentLength = size - overhead;
  if (contentLength < 0) return null;
  const content = fillDeterministicBytes(contentLength, seed);
  const crc = crc32(content);
  const local = concatBytes(Uint8Array.of(0x50,0x4b,0x03,0x04),u16le(20),u16le(0),u16le(0),u16le(0),u16le(0),u32le(crc),u32le(contentLength),u32le(contentLength),u16le(name.length),u16le(0),name,content);
  const centralOffset = local.length;
  const central = concatBytes(Uint8Array.of(0x50,0x4b,0x01,0x02),u16le(20),u16le(20),u16le(0),u16le(0),u16le(0),u16le(0),u32le(crc),u32le(contentLength),u32le(contentLength),u16le(name.length),u16le(0),u16le(0),u16le(0),u16le(0),u32le(0),u32le(0),name);
  const eocd = concatBytes(Uint8Array.of(0x50,0x4b,0x05,0x06),u16le(0),u16le(0),u16le(1),u16le(1),u32le(central.length),u32le(centralOffset),u16le(0));
  return concatBytes(local, central, eocd);
}
function makeSafetensorsBytes(size, seed) {
  if (size < 10) return null;
  const headerLength = size - 8;
  const header = new Uint8Array(headerLength);
  header[0] = 0x7b; header[1] = 0x7d;
  const ws = [0x20,0x09,0x0a,0x0d];
  const next = seededByteGenerator(seed);
  for (let i = 2; i < header.length; i++) header[i] = ws[next() % ws.length];
  return concatBytes(u64le(headerLength), header);
}
function makeGgufBytes(size, seed) {
  const key = encoder.encode('general.name');
  const fixed = 24 + 8 + key.length + 4 + 8;
  const valueLength = size - fixed;
  if (valueLength < 0) return null;
  const value = fillPrintable(valueLength, seed);
  return concatBytes(encoder.encode('GGUF'),u32le(3),u64le(0),u64le(1),u64le(key.length),key,u32le(8),u64le(value.length),value);
}

const formatGenerators = { text:makeTextBytes, json:makeJsonBytes, pdf:makePdfBytes, png:makePngBytes, zip:makeZipBytes, safetensors:makeSafetensorsBytes, gguf:makeGgufBytes };
const magicByFormat = {
  pdf:encoder.encode('%PDF-'), png:Uint8Array.of(137,80,78,71,13,10,26,10), zip:Uint8Array.of(0x50,0x4b,0x03,0x04),
  jpg:Uint8Array.of(0xff,0xd8,0xff), gif:encoder.encode('GIF8'), '7z':Uint8Array.of(0x37,0x7a,0xbc,0xaf,0x27,0x1c),
  rar:encoder.encode('Rar!'), flac:encoder.encode('fLaC'), gguf:encoder.encode('GGUF'), sqlite:encoder.encode('SQLite format 3\0'),
  exe:encoder.encode('MZ'), dll:encoder.encode('MZ'), elf:Uint8Array.of(0x7f,0x45,0x4c,0x46), mkv:Uint8Array.of(0x1a,0x45,0xdf,0xa3)
};
function startsWithBytes(bytes, prefix) { if (!prefix || bytes.length < prefix.length) return false; for (let i=0;i<prefix.length;i++) if (bytes[i]!==prefix[i]) return false; return true; }
function includesAscii(bytes, needle) {
  const n = encoder.encode(needle);
  outer: for (let i=0;i<=bytes.length-n.length;i++) { for (let j=0;j<n.length;j++) if (bytes[i+j]!==n[j]) continue outer; return true; }
  return false;
}
function endsWithAsciiTrimmed(bytes, needle) {
  let end=bytes.length; while (end && [0x20,0x09,0x0a,0x0d].includes(bytes[end-1])) end--;
  const n=encoder.encode(needle); if (end<n.length) return false;
  for (let i=0;i<n.length;i++) if (bytes[end-n.length+i]!==n[i]) return false; return true;
}

function validatePdf(bytes) {
  const recognizable=startsWithBytes(bytes,magicByFormat.pdf);
  if (!recognizable) return {recognizable:false,valid:false,strict:false,score:0,details:'Missing %PDF- header'};
  const hasObj=includesAscii(bytes,' obj')&&includesAscii(bytes,'endobj'), hasXref=includesAscii(bytes,'xref'), hasTrailer=includesAscii(bytes,'trailer'), hasStart=includesAscii(bytes,'startxref'), eof=endsWithAsciiTrimmed(bytes,'%%EOF');
  let strict=false;
  if (hasStart) { const text=decoder.decode(bytes); const m=text.match(/startxref\s+(\d+)\s+%%EOF\s*$/s); if (m) { const off=Number(m[1]); strict=Number.isInteger(off)&&off>=0&&off+4<=bytes.length&&decoder.decode(bytes.slice(off,off+4))==='xref'; } }
  const valid=hasObj&&hasXref&&hasTrailer&&hasStart&&eof;
  return {recognizable:true,valid,strict:valid&&strict,score:strict?100:valid?90:35,details:strict?'PDF header, objects, xref, trailer and startxref validated':valid?'PDF structure present':'PDF signature found but structure is incomplete'};
}
function validatePng(bytes) {
  if (!startsWithBytes(bytes,magicByFormat.png)) return {recognizable:false,valid:false,strict:false,score:0,details:'Missing PNG signature'};
  let off=8,ihdr=false,idat=false,iend=false,crcOk=true,dimensions='';
  try {
    while (off+12<=bytes.length) {
      const len=((bytes[off]<<24)|(bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3])>>>0;
      if (off+12+len>bytes.length) throw new Error('Truncated chunk');
      const type=decoder.decode(bytes.slice(off+4,off+8)), data=bytes.slice(off+8,off+8+len);
      const expected=((bytes[off+8+len]<<24)|(bytes[off+9+len]<<16)|(bytes[off+10+len]<<8)|bytes[off+11+len])>>>0;
      if (crc32(concatBytes(bytes.slice(off+4,off+8),data))!==expected) crcOk=false;
      if (type==='IHDR') { ihdr=len===13; if (ihdr) { const w=((data[0]<<24)|(data[1]<<16)|(data[2]<<8)|data[3])>>>0,h=((data[4]<<24)|(data[5]<<16)|(data[6]<<8)|data[7])>>>0; dimensions=`${w}×${h}`; ihdr=w>0&&h>0; } }
      if (type==='IDAT') idat=true; off+=12+len; if (type==='IEND') { iend=len===0; break; }
    }
  } catch(e) { return {recognizable:true,valid:false,strict:false,score:30,details:`PNG signature found, ${e.message}`}; }
  const valid=ihdr&&idat&&iend, strict=valid&&crcOk&&off===bytes.length;
  return {recognizable:true,valid,strict,score:strict?100:valid?85:35,details:strict?`PNG chunks and CRCs valid${dimensions?` (${dimensions})`:''}`:valid?'Required PNG chunks found':'PNG signature found but required chunks are missing'};
}
function validateZip(bytes) {
  const recognizable=startsWithBytes(bytes,magicByFormat.zip); if (!recognizable) return {recognizable:false,valid:false,strict:false,score:0,details:'Missing ZIP local header'};
  let eocd=-1; for (let i=Math.max(0,bytes.length-65557);i<=bytes.length-4;i++) if(bytes[i]===0x50&&bytes[i+1]===0x4b&&bytes[i+2]===0x05&&bytes[i+3]===0x06)eocd=i;
  if(eocd<0||eocd+22>bytes.length)return{recognizable:true,valid:false,strict:false,score:35,details:'ZIP header found but central-directory end is missing'};
  const dv=new DataView(bytes.buffer,bytes.byteOffset+eocd,bytes.length-eocd),centralSize=dv.getUint32(12,true),centralOff=dv.getUint32(16,true);
  const valid=centralOff+centralSize<=eocd&&centralOff+4<=bytes.length&&bytes[centralOff]===0x50&&bytes[centralOff+1]===0x4b&&bytes[centralOff+2]===0x01&&bytes[centralOff+3]===0x02;
  let strict=false;
  if(valid&&bytes.length>=30){const local=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),crc=local.getUint32(14,true),csize=local.getUint32(18,true),nameLen=local.getUint16(26,true),extraLen=local.getUint16(28,true),dataStart=30+nameLen+extraLen;if(dataStart+csize<=bytes.length)strict=crc32(bytes.slice(dataStart,dataStart+csize))===crc;}
  return {recognizable:true,valid,strict:valid&&strict,score:strict?100:valid?88:35,details:strict?'ZIP central directory and stored-file CRC validated':valid?'ZIP central directory is structurally valid':'ZIP structure is incomplete'};
}
function validateJson(bytes){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);JSON.parse(text);return{recognizable:true,valid:true,strict:true,score:100,details:'UTF-8 JSON parsed successfully'};}catch{return{recognizable:false,valid:false,strict:false,score:0,details:'JSON parse failed'};}}
function validateText(bytes){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),sample=text.slice(0,8192),printable=[...sample].filter(c=>c==='\n'||c==='\r'||c==='\t'||c.charCodeAt(0)>=32).length,ratio=sample.length?printable/[...sample].length:1,valid=ratio>=0.9;return{recognizable:valid,valid,strict:valid&&ratio>=0.98,score:Math.round(ratio*100),details:`UTF-8 printable ratio ${(ratio*100).toFixed(1)}%`};}catch{return{recognizable:false,valid:false,strict:false,score:0,details:'Invalid UTF-8 text'};}}
function validateSafetensors(bytes){if(bytes.length<10)return{recognizable:false,valid:false,strict:false,score:0,details:'Too small for Safetensors header'};const len=readU64le(bytes,0);if(len>BigInt(bytes.length-8)||len>BigInt(Number.MAX_SAFE_INTEGER))return{recognizable:false,valid:false,strict:false,score:10,details:'Invalid Safetensors header length'};try{const header=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(8,8+Number(len))),obj=JSON.parse(header),valid=obj&&typeof obj==='object'&&!Array.isArray(obj);return{recognizable:valid,valid,strict:valid&&8+Number(len)<=bytes.length,score:valid?100:20,details:valid?'Safetensors JSON header parsed and offsets are in bounds':'Safetensors header is not an object'};}catch{return{recognizable:false,valid:false,strict:false,score:0,details:'Safetensors JSON header failed to parse'};}}
function validateGguf(bytes){if(!startsWithBytes(bytes,magicByFormat.gguf)||bytes.length<24)return{recognizable:false,valid:false,strict:false,score:0,details:'Missing or truncated GGUF header'};const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),version=dv.getUint32(4,true),tensors=readU64le(bytes,8),kv=readU64le(bytes,16),valid=(version===2||version===3)&&tensors<=1_000_000n&&kv<=1_000_000n;let strict=valid;if(valid&&kv>0n){try{let off=24;for(let i=0n;i<kv;i++){const keyLen=Number(readU64le(bytes,off));off+=8;if(off+keyLen+4>bytes.length){strict=false;break;}off+=keyLen;const type=new DataView(bytes.buffer,bytes.byteOffset+off,4).getUint32(0,true);off+=4;if(type!==8||off+8>bytes.length){strict=false;break;}const valLen=Number(readU64le(bytes,off));off+=8;if(off+valLen>bytes.length){strict=false;break;}off+=valLen;}}catch{strict=false;}}return{recognizable:true,valid,strict,score:strict?100:valid?80:30,details:strict?`GGUF v${version} header and metadata parsed`:valid?`GGUF v${version} header recognized`:`Unsupported GGUF version ${version}`};}
function validateGeneric(bytes,format){if(format==='mp4'){const recognizable=bytes.length>=12&&decoder.decode(bytes.slice(4,8))==='ftyp';return{recognizable,valid:recognizable,strict:false,score:recognizable?65:0,details:recognizable?'ISO BMFF ftyp box recognized':'Missing ftyp box'};}if(format==='mp3'){const recognizable=startsWithBytes(bytes,encoder.encode('ID3'))||(bytes.length>=2&&bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0);return{recognizable,valid:recognizable,strict:false,score:recognizable?60:0,details:recognizable?'MP3 signature/frame sync recognized':'Missing MP3 signature'};}const magic=magicByFormat[format],recognizable=magic?startsWithBytes(bytes,magic):false;return{recognizable,valid:false,strict:false,score:recognizable?45:0,details:recognizable?`${format.toUpperCase()} signature recognized`:`No supported ${format.toUpperCase()} structure validator`};}
function validateCandidate(bytes,filename){const format=formatFromExtension(filename);let v;if(format==='pdf')v=validatePdf(bytes);else if(format==='png')v=validatePng(bytes);else if(format==='zip')v=validateZip(bytes);else if(format==='json')v=validateJson(bytes);else if(format==='text')v=validateText(bytes);else if(format==='safetensors')v=validateSafetensors(bytes);else if(format==='gguf')v=validateGguf(bytes);else v=validateGeneric(bytes,format);return{format,...v};}

function generateFormatAwareBytes(filename,size,seed){const format=formatFromExtension(filename),generator=formatGenerators[format];if(!generator)return null;const bytes=generator(size,seed);return bytes?{format,bytes}:null;}
function makeVirtualRecipe(filename,size,ordinal,strategy,format){const seed=makeSeed(filename,size,ordinal);if(strategy==='format'&&formatGenerators[format]){const payload=base64urlEncode(JSON.stringify({format,seed,filename}));return{seed,address:`ICFMT1:${size}:${format}:${payload}`,formatAware:true};}return{seed,address:`ICXL1:${size}:seeded:${base64urlEncode(seed)}`,formatAware:false};}
function passesValidation(v,level,minScore){if(v.score<minScore)return false;if(level==='any')return true;if(level==='signature')return v.recognizable;if(level==='readable')return v.valid;if(level==='strict')return v.strict;return true;}
function virtualValidation(format,strategy){const supported=strategy==='format'&&Boolean(formatGenerators[format]);if(supported)return{format,recognizable:true,valid:true,strict:false,score:90,details:'Format-aware virtual template. Structure is guaranteed by the recipe, but the full object is not materialized in this tab.'};return{format,recognizable:false,valid:false,strict:false,score:0,details:'Large seeded bytes are not materialized, so readability cannot be established.'};}

function downloadBytes(bytes,filename){const blob=new Blob([bytes],{type:'application/octet-stream'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename||'corridor-candidate.bin';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function badgeForValidation(v){if(v.strict)return'STRICT PASS';if(v.valid)return'READABLE';if(v.recognizable)return'SIGNATURE ONLY';return'GARBLED / UNKNOWN';}
function renderResults(results,attempts){currentResults=results;const readable=results.filter(x=>x.validation.valid).length,strict=results.filter(x=>x.validation.strict).length;const summary=`<div class="notice"><strong>${results.length.toLocaleString()} Babel candidates</strong><br><span class="muted">${attempts.toLocaleString()} attempts · ${readable.toLocaleString()} readable/template-valid · ${strict.toLocaleString()} strict parser-valid. Filename, byte-size and validation constraints are all applied before a result is shown.</span></div>`;const rows=results.map((r,idx)=>{const address=r.kind==='literal'?r.path:r.recipe,shown=address.length>520?`${address.slice(0,250)}…${address.slice(-250)}`:address,badge=badgeForValidation(r.validation),format=r.validation.format==='binary'?'unknown format':r.validation.format.toUpperCase();return`<article class="regex-result" data-babel-result="${idx}"><div><span class="eyebrow">${r.kind==='literal'?'Literal Babel candidate':'Virtual Babel candidate'}</span><strong>${escapeHtml(r.filename)}</strong><div class="regex-meta"><span>${formatBytes(r.size)}</span><span>${r.depth.toLocaleString()} levels${r.kind==='virtual'?' estimated':''}</span><span>${escapeHtml(format)}</span><span>${escapeHtml(badge)} · score ${r.validation.score}</span></div><div class="muted" style="margin-top:6px">${escapeHtml(r.validation.details)}</div></div><code title="${escapeHtml(address)}">${escapeHtml(shown)}</code><div class="button-row" style="margin-top:0"><button class="secondary babel-copy" data-i="${idx}">Copy ${r.kind==='literal'?'address':'recipe'}</button>${r.kind==='literal'?`<button class="secondary babel-download" data-i="${idx}">Download</button>`:''}</div></article>`;}).join('');$('#regex-results').innerHTML=summary+rows;document.querySelectorAll('.babel-copy').forEach(btn=>{btn.onclick=async()=>{const r=currentResults[Number(btn.dataset.i)];await navigator.clipboard.writeText(r.kind==='literal'?r.path:r.recipe);const old=btn.textContent;btn.textContent='Copied';setTimeout(()=>{btn.textContent=old;},900);};});document.querySelectorAll('.babel-download').forEach(btn=>{btn.onclick=()=>{const r=currentResults[Number(btn.dataset.i)];downloadBytes(r.bytes,r.filename);};});}

async function runBabelRegexSearch(){const button=$('#regex-generate'),status=$('#babel-regex-status'),target=$('#regex-results');try{const raw=$('#regex-input').value,{source,flags}=regexParts(raw),repeatCap=Math.max(1,Math.min(HARD_REPEAT_CAP,Number($('#regex-repeat-cap').value)||256)),ast=new FilenameRegexParser(source,repeatCap).parse(),nameValidator=new RegExp(`^(?:${source})$`,flags.replace(/[gy]/g,'')),simpleNumeric=detectSimpleNumericPattern(source),numericStart=Math.max(0,Number($('#regex-numeric-start').value)||0),count=Math.min(MAX_RESULTS,Math.max(1,Number($('#regex-count').value)||100)),budget=Math.min(HARD_BUDGET,Math.max(1,Number($('#regex-budget').value)||5000)),minBytes=Math.max(0,Math.min(HARD_MAX_BYTES,Number($('#regex-min-bytes').value)||0)),maxBytes=Math.max(1,Math.min(HARD_MAX_BYTES,Number($('#regex-max-bytes').value)||65536)),mode=$('#regex-depth-mode').value,validationLevel=$('#regex-validation-level').value,strategy=$('#regex-payload-strategy').value,minScore=Math.max(0,Math.min(100,Number($('#regex-min-score').value)||0));if(minBytes>maxBytes)throw new Error('Minimum bytes cannot be larger than maximum bytes.');button.disabled=true;target.innerHTML='<div class="notice">Generating and validating Babel candidates…</div>';status.textContent='Starting candidate search…';const seen=new Set(),results=[];let attempts=0,rejectedFormat=0;const numericLimit=simpleNumeric?10**simpleNumeric.width:0;while(attempts<budget&&results.length<count){let filename;if(simpleNumeric){const n=(numericStart+attempts)%numericLimit;filename=`${simpleNumeric.prefix}${String(n).padStart(simpleNumeric.width,'0')}${simpleNumeric.suffix}`;}else filename=generateName(ast,mode);attempts++;nameValidator.lastIndex=0;if(!nameValidator.test(filename))continue;const size=chooseSize(minBytes,maxBytes,mode),key=`${filename}\0${size}`;if(seen.has(key))continue;seen.add(key);const ordinal=attempts-1,seed=makeSeed(filename,size,ordinal),format=formatFromExtension(filename);if(size<=MAX_LITERAL_BYTES){let bytes;if(strategy==='format'){const generated=generateFormatAwareBytes(filename,size,seed);if(!generated){rejectedFormat++;continue;}bytes=generated.bytes;}else bytes=fillDeterministicBytes(size,seed);const validation=validateCandidate(bytes,filename);if(!passesValidation(validation,validationLevel,minScore))continue;const path=bytesToPath(bytes);results.push({kind:'literal',filename,size,depth:normalizePath(path).length,bytes,path,seed,ordinal,validation});}else{const validation=virtualValidation(format,strategy);if(validationLevel==='strict')continue;if(!passesValidation(validation,validationLevel,minScore))continue;const recipe=makeVirtualRecipe(filename,size,ordinal,strategy,format);results.push({kind:'virtual',filename,size,depth:estimatedDepth(size),recipe:recipe.address,seed,ordinal,validation});}if(attempts%250===0){status.textContent=`${attempts.toLocaleString()} / ${budget.toLocaleString()} attempts · ${results.length.toLocaleString()} results · ${rejectedFormat.toLocaleString()} unsupported-size/format rejects`;await new Promise(requestAnimationFrame);}}if(!results.length){target.innerHTML='<div class="notice warn">No candidates passed the current filename, byte-size and validation constraints. If Readable/Strict is selected, use a supported format and a size large enough for that format\'s minimum structure.</div>';status.textContent=`Finished ${attempts.toLocaleString()} attempts with no accepted results.`;return;}results.sort((a,b)=>mode==='balanced'?a.ordinal-b.ordinal:b.size-a.size||a.ordinal-b.ordinal);renderResults(results,attempts);const largest=results.reduce((a,b)=>a.size>=b.size?a:b);status.textContent=`Finished ${attempts.toLocaleString()} attempts · ${results.length.toLocaleString()} accepted · largest ${formatBytes(largest.size)} / ${largest.depth.toLocaleString()} levels.`;}catch(error){target.innerHTML=`<div class="notice error">${escapeHtml(error.message)}</div>`;status.textContent='Search stopped because the regex, byte constraints, or validation settings are invalid.';}finally{button.disabled=false;}}

function installUi(){const panel=$('#panel-regex'),tab=document.querySelector('[data-tab="regex"]');if(!panel||!tab)return;tab.textContent='Babel Regex';panel.innerHTML=`<div class="card"><span class="eyebrow">Filename → candidate bytes → format validation → Babel address</span><h3>Babel regex candidate search</h3><p class="help">Generate candidate filenames from a regex, constrain candidate byte size, then either generate format-aware bytes or brute-force deterministic bytes. Every materialized candidate is validated against the file type implied by its extension before it can be shown.</p><div class="grid-2"><div><label for="regex-input">Filename regex</label><input id="regex-input" class="mono" type="text" value="EFTA[0-9]{8}\\.pdf"></div><div><label for="regex-count">Results</label><input id="regex-count" type="number" min="1" max="${MAX_RESULTS}" value="100"></div></div><div class="grid-3" style="margin-top:16px"><div><label for="regex-min-bytes">Minimum bytes</label><input id="regex-min-bytes" type="number" min="0" max="${HARD_MAX_BYTES}" value="512"></div><div><label for="regex-max-bytes">Maximum bytes (up to 1 TiB)</label><input id="regex-max-bytes" type="number" min="1" max="${HARD_MAX_BYTES}" value="65536"></div><div><label for="regex-depth-mode">Size/depth bias</label><select id="regex-depth-mode" class="input"><option value="deep" selected>Bias larger/deeper</option><option value="max">Always maximum bytes</option><option value="balanced">Balanced/random</option></select></div><div><label for="regex-budget">Candidate attempts (up to 10,000,000)</label><input id="regex-budget" type="number" min="1" max="${HARD_BUDGET}" value="5000"></div><div><label for="regex-repeat-cap">Open-ended regex repeat cap</label><input id="regex-repeat-cap" type="number" min="1" max="${HARD_REPEAT_CAP}" value="256"></div><div><label for="regex-numeric-start">Numeric start / offset</label><input id="regex-numeric-start" type="number" min="0" value="0"></div></div><div class="grid-3" style="margin-top:16px"><div><label for="regex-payload-strategy">Payload strategy</label><select id="regex-payload-strategy" class="input"><option value="format" selected>Format-aware generation</option><option value="random">Deterministic random bytes</option></select></div><div><label for="regex-validation-level">Validation requirement</label><select id="regex-validation-level" class="input"><option value="any">Any bytes</option><option value="signature">Recognizable signature</option><option value="readable" selected>Structurally valid / readable</option><option value="strict">Strict materialized validation</option></select></div><div><label for="regex-min-score">Minimum validation score (0–100)</label><input id="regex-min-score" type="number" min="0" max="100" value="80"></div></div><div class="notice" style="margin-top:16px"><strong>Format-aware generators:</strong> PDF, PNG, ZIP, JSON, text/CSV/Markdown, GGUF, and Safetensors. Other common extensions can still receive signature checks when using random-byte mode. Strict validation only accepts fully materialized candidates up to ${formatBytes(MAX_LITERAL_BYTES)}.</div><div class="notice" style="margin-top:12px"><strong>Numeric patterns:</strong> <code>EFTA[0-9]{8}\\.pdf</code> is enumerated sequentially. Set Numeric start to <code>2822476</code> to begin at <code>EFTA02822476.pdf</code>.</div><div class="button-row"><button id="regex-generate">Search validated Babel candidates</button></div><div id="babel-regex-status" class="muted" style="margin-top:12px">Ready.</div></div><div id="regex-results"><div class="notice">Choose filename, size, generation strategy and validation conditions, then search.</div></div>`;$('#regex-generate').onclick=runBabelRegexSearch;$('#regex-input').addEventListener('keydown',event=>{if(event.key==='Enter')runBabelRegexSearch();});}

installUi();
