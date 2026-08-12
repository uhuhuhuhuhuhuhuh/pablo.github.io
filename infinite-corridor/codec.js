export const ALPHABET = [
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
  '0','1','2','3','4','5','6','7','8','9','!',' ','&','(',')','-','_','+'
];

export const ALPHABET_LENGTH = 70;
export const DIRECTORY_OBJECTS = 4900;
const INDEX = new Map(ALPHABET.map((c, i) => [c, i]));

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

// Exact browser reimplementation of babel-usb's bijective base conversion.
export function bytesToSegments(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  let index = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    index = index * 256n + BigInt(bytes[i] + 1);
  }
  const out = [];
  const base = BigInt(DIRECTORY_OBJECTS);
  while (index > 0n) {
    index -= 1n;
    const digit = Number(index % base);
    out.push(directoryName(digit));
    index /= base;
  }
  out.reverse();
  return out;
}

export function segmentsToBytes(segments) {
  const base = BigInt(DIRECTORY_OBJECTS);
  let index = 0n;
  for (const segment of segments) {
    index = index * base + BigInt(directoryIndex(segment) + 1);
  }
  const bytes = [];
  while (index > 0n) {
    index -= 1n;
    bytes.push(Number(index % 256n));
    index /= 256n;
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
