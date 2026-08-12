const TOKEN_MAGIC = 'ICS1';
const SALT_BYTES = 16;

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('ICS1 contains invalid base64url data.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
  let binary;
  try { binary = atob(padded); }
  catch { throw new Error('ICS1 contains malformed encoded data.'); }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function gzip(bytes) {
  if (!('CompressionStream' in globalThis)) return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  if (!('DecompressionStream' in globalThis)) throw new Error('This browser cannot decompress an ICS1 gzip payload.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function randomSalt() {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return bytesToBase64Url(salt);
}

export async function createIcsToken(inputBytes) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  const salt = randomSalt();
  const digest = await sha256(bytes);

  let mode = 'R';
  let packed = bytes;
  try {
    const compressed = await gzip(bytes);
    if (compressed && compressed.length + 24 < bytes.length) {
      mode = 'G';
      packed = compressed;
    }
  } catch {
    // Compression is optional. Raw encoding remains fully self-contained.
  }

  const token = [
    TOKEN_MAGIC,
    salt,
    mode,
    bytesToBase64Url(digest),
    bytesToBase64Url(packed),
  ].join('.');

  return {
    token,
    salt,
    mode,
    originalBytes: bytes.length,
    packedBytes: packed.length,
  };
}

export async function decodeIcsToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5 || parts[0] !== TOKEN_MAGIC) throw new Error('Not a valid ICS1 self-contained share token.');

  const [, salt, mode, expectedHash, payload] = parts;
  const saltBytes = base64UrlToBytes(salt);
  if (saltBytes.length < 8 || saltBytes.length > 64) throw new Error('ICS1 salt length is invalid.');
  // The salt exists only to make otherwise identical share URLs look different.
  // It does not affect reconstruction and is intentionally discarded here.

  const packed = base64UrlToBytes(payload);
  let bytes;
  if (mode === 'R') bytes = packed;
  else if (mode === 'G') bytes = await gunzip(packed);
  else throw new Error(`Unsupported ICS1 payload mode: ${mode}.`);

  const actualHash = await sha256(bytes);
  const expectedHashBytes = base64UrlToBytes(expectedHash);
  if (!equalBytes(actualHash, expectedHashBytes)) throw new Error('ICS1 integrity check failed. The share URL may be incomplete or corrupted.');

  return {
    bytes,
    mode,
    saltDiscarded: true,
  };
}

export function formatIcsBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function inferMime(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const map = {
    txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json', xml:'application/xml',
    html:'text/html', css:'text/css', js:'text/javascript', pdf:'application/pdf', png:'image/png',
    jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
    zip:'application/zip', mkv:'video/x-matroska', mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg',
    flac:'audio/flac', wav:'audio/wav'
  };
  return map[ext] || 'application/octet-stream';
}
