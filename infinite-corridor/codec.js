export const ALPHABET = [
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
  '0','1','2','3','4','5','6','7','8','9','!',' ','&','(',')','-','_','+'
];

export const ALPHABET_LENGTH = 70;
export const DIRECTORY_OBJECTS = 4900;
const INDEX = new Map(ALPHABET.map((c, i) => [c, i]));
const BASE_256 = 256n;
const BASE_4900 = BigInt(DIRECTORY_OBJECTS);
const BYTE_GROUP = 32;
const SEGMENT_GROUP = 32;

function powBigInt(base, exponent) {
  let b = base;
  let e = BigInt(exponent);
  let result = 1n;
  while (e > 0n) {
    if (e & 1n) result *= b;
    b *= b;
    e >>= 1n;
  }
  return result;
}

const BYTE_POWERS = Array.from({ length: BYTE_GROUP + 1 }, (_, i) => powBigInt(BASE_256, i));
const SEGMENT_GROUP_BASE = powBigInt(BASE_4900, SEGMENT_GROUP);

export function directoryName(value) {
  if (!Number.isInteger(value) || value < 0 || value >= DIRECTORY_OBJECTS) {
    throw new RangeError('Directory index must be 0..4899');
  }
  return ALPHABET[Math.floor(value / ALPHABET_LENGTH)] + ALPHABET[value % ALPHABET_LENGTH];
}

export function directoryIndex(name) {
  if (typeof name !== 'string' || [...name].length !== 2) {
    throw new Error(`Invalid Corridor segment: ${name}`);
  }
  const chars = [...name];
  const hi = INDEX.get(chars[0]);
  const lo = INDEX.get(chars[1]);
  if (hi === undefined || lo === undefined) throw new Error(`Invalid Corridor segment: ${name}`);
  return hi * ALPHABET_LENGTH + lo;
}

export function normalizePath(path) {
  let p = String(path ?? '').trim().replaceAll('\\', '/');
  p = p.replace(/^https?:\/\/[^/]+\//i, '/');
  p = p.split('#')[0].split('?')[0];
  const raw = p.split('/').filter(Boolean);
  if (raw.at(-1)?.toLowerCase() === 'file') raw.pop();
  return raw.map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function bytesToBijectiveIndex(bytes) {
  let index = 0n;
  for (let end = bytes.length; end > 0;) {
    const start = Math.max(0, end - BYTE_GROUP);
    let chunk = 0n;
    for (let i = end - 1; i >= start; i--) {
      chunk = chunk * BASE_256 + BigInt(bytes[i] + 1);
    }
    index = index * BYTE_POWERS[end - start] + chunk;
    end = start;
  }
  return index;
}

function bijectiveDigitCount(index) {
  if (index <= 0n) return 0;
  const bitLength = index.toString(2).length;
  let length = Math.max(1, Math.floor((bitLength - 1) / Math.log2(DIRECTORY_OBJECTS)) + 1);

  const sumFor = (n) => (powBigInt(BASE_4900, n) - 1n) / (BASE_4900 - 1n);
  let lower = sumFor(length);
  while (index < lower && length > 1) {
    length--;
    lower = sumFor(length);
  }
  let next = lower + powBigInt(BASE_4900, length);
  while (index >= next) {
    length++;
    lower = next;
    next = lower + powBigInt(BASE_4900, length);
  }
  return { length, offset: lower };
}

// Exact browser reimplementation of babel-usb's bijective base conversion.
// Uses grouped BigInt operations so large files do not require one huge
// multiplication/division for every input byte and every output segment.
export function bytesToSegments(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (!bytes.length) return [];

  const index = bytesToBijectiveIndex(bytes);
  const info = bijectiveDigitCount(index);
  if (!info) return [];

  let standard = index - info.offset;
  const out = new Array(info.length);
  let position = info.length;

  while (position > 0) {
    const take = Math.min(SEGMENT_GROUP, position);
    const groupBase = take === SEGMENT_GROUP ? SEGMENT_GROUP_BASE : powBigInt(BASE_4900, take);
    let remainder = standard % groupBase;
    standard /= groupBase;

    for (let i = 0; i < take; i++) {
      const digit = Number(remainder % BASE_4900);
      remainder /= BASE_4900;
      out[--position] = directoryName(digit);
    }
  }
  return out;
}

export function segmentsToBytes(segments) {
  const base = BASE_4900;
  let index = 0n;
  for (const segment of segments) {
    index = index * base + BigInt(directoryIndex(segment) + 1);
  }
  const bytes = [];
  while (index > 0n) {
    index -= 1n;
    bytes.push(Number(index % BASE_256));
    index /= BASE_256;
  }
  return Uint8Array.from(bytes);
}

export function pathToBytes(path) {
  return segmentsToBytes(normalizePath(path));
}

export function bytesToPath(bytes) {
  const segments = bytesToSegments(bytes);
  return '/' + (segments.length ? segments.join('/') + '/' : '') + 'file';
}

export function estimatedDepth(byteLength) {
  if (!byteLength) return 0;
  return Math.ceil((byteLength * 8) / Math.log2(DIRECTORY_OBJECTS));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
}
