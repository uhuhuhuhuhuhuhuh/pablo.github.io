export const IC2_VERSION = 2;
export const MAX_TOKEN_CHARS = 1_500_000;
export const FASTCDC = Object.freeze({ min: 16 * 1024, avg: 64 * 1024, max: 256 * 1024, version: 1 });

export function bytesToBase64Url(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid Base64URL data.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concatBytes(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function formatBytes(bytes) {
  const n = typeof bytes === 'bigint' ? Number(bytes) : Number(bytes);
  if (!Number.isFinite(n)) return String(bytes) + ' B';
  if (n < 1024) return `${n.toLocaleString()} B`;
  const units = ['KiB','MiB','GiB','TiB','PiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

export function cleanFilename(name) {
  const cleaned = String(name || 'shared-file.bin').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return (cleaned || 'shared-file.bin').slice(0, 255);
}

export function inferMime(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const map = {
    txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json', xml:'application/xml',
    html:'text/html', css:'text/css', js:'text/javascript', pdf:'application/pdf', png:'image/png',
    jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
    zip:'application/zip', mkv:'video/x-matroska', mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg',
    flac:'audio/flac', wav:'audio/wav', wasm:'application/wasm', ic2:'application/x-infinite-corridor'
  };
  return map[ext] || 'application/octet-stream';
}

export class BinWriter {
  constructor() { this.parts = []; this.length = 0; }
  bytes(b) { const v = b instanceof Uint8Array ? b : new Uint8Array(b); this.parts.push(v); this.length += v.length; return this; }
  u8(v) { return this.bytes(Uint8Array.of(v & 255)); }
  varint(value) {
    let n = typeof value === 'bigint' ? value : BigInt(value);
    if (n < 0n) throw new Error('Negative varint.');
    const a = [];
    do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; a.push(b); } while (n);
    return this.bytes(Uint8Array.from(a));
  }
  finish() { return concatBytes(this.parts); }
}

export class BinReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  need(n) { if (this.pos + n > this.bytes.length) throw new Error('Truncated IC2 manifest.'); }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  take(n) { this.need(n); const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  varint() {
    let out = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      out |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return out;
      shift += 7n;
    }
    throw new Error('IC2 varint is too large.');
  }
  numberVarint(label='value') {
    const n = this.varint();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds JavaScript safe integer range.`);
    return Number(n);
  }
  get done() { return this.pos === this.bytes.length; }
}

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotr = (x,n) => (x >>> n) | (x << (32-n));
export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buf = new Uint8Array(64); this.bufLen = 0; this.bytes = 0n; this.w = new Uint32Array(64); this.finished = false;
  }
  update(input) {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.bytes += BigInt(data.length);
    let p = 0;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0,take), this.bufLen); this.bufLen += take; p += take;
      if (this.bufLen === 64) { this._block(this.buf,0); this.bufLen = 0; }
    }
    while (p + 64 <= data.length) { this._block(data,p); p += 64; }
    if (p < data.length) { this.buf.set(data.subarray(p),0); this.bufLen = data.length-p; }
    return this;
  }
  _block(d, off) {
    const w=this.w;
    for(let i=0;i<16;i++){const j=off+i*4;w[i]=((d[j]<<24)|(d[j+1]<<16)|(d[j+2]<<8)|d[j+3])>>>0;}
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];const s0=(rotr(a,7)^rotr(a,18)^(a>>>3))>>>0;const s1=(rotr(b,17)^rotr(b,19)^(b>>>10))>>>0;w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
    let [a,b,c,d0,e,f,g,h]=this.h;
    for(let i=0;i<64;i++){const S1=(rotr(e,6)^rotr(e,11)^rotr(e,25))>>>0;const ch=((e&f)^((~e)&g))>>>0;const t1=(h+S1+ch+K[i]+w[i])>>>0;const S0=(rotr(a,2)^rotr(a,13)^rotr(a,22))>>>0;const maj=((a&b)^(a&c)^(b&c))>>>0;const t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d0+t1)>>>0;d0=c;c=b;b=a;a=(t1+t2)>>>0;}
    this.h[0]=(this.h[0]+a)>>>0;this.h[1]=(this.h[1]+b)>>>0;this.h[2]=(this.h[2]+c)>>>0;this.h[3]=(this.h[3]+d0)>>>0;
    this.h[4]=(this.h[4]+e)>>>0;this.h[5]=(this.h[5]+f)>>>0;this.h[6]=(this.h[6]+g)>>>0;this.h[7]=(this.h[7]+h)>>>0;
  }
  digest() {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    this.finished = true;
    const bitLen = this.bytes * 8n;
    const tail = new Uint8Array(this.bufLen < 56 ? 64 : 128);
    tail.set(this.buf.subarray(0,this.bufLen)); tail[this.bufLen]=0x80;
    for(let i=0;i<8;i++) tail[tail.length-1-i]=Number((bitLen>>BigInt(i*8))&0xffn);
    for(let p=0;p<tail.length;p+=64)this._block(tail,p);
    const out=new Uint8Array(32);
    for(let i=0;i<8;i++){const v=this.h[i];out[i*4]=v>>>24;out[i*4+1]=v>>>16;out[i*4+2]=v>>>8;out[i*4+3]=v;}
    return out;
  }
}

export function sha256(bytes) { return new Sha256().update(bytes).digest(); }
