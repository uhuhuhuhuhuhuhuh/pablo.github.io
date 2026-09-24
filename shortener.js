// Client for the corridor-link shortener (https://corridor-link.netlify.app).
// The long share link is compressed and AES-GCM encrypted in the browser. The
// service stores only the ciphertext; the key travels in the short link's
// #fragment, which browsers never send to servers.
// Keep in sync with corridor-link/public/seal.js.
export const SHORTENER_BASE = 'https://corridor-link.netlify.app';
const FORMAT_VERSION = 1;

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

// Body layout: version (1 byte) | IV (12 bytes) | AES-GCM(deflate-raw(UTF-8 URL)).
export async function sealLink(longUrl) {
  const raw = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const packed = await pipe(new TextEncoder().encode(longUrl), new CompressionStream('deflate-raw'));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  const body = new Uint8Array(1 + iv.length + sealed.length);
  body[0] = FORMAT_VERSION; body.set(iv, 1); body.set(sealed, 1 + iv.length);
  return { body, key: b64u(raw) };
}

export async function openLink(body, keyText) {
  if (body[0] !== FORMAT_VERSION || body.length < 29) throw new Error('Unsupported short-link format.');
  const raw = unb64u(keyText);
  if (raw.length !== 16) throw new Error('The short link key is incomplete.');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  let packed;
  try { packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.subarray(1, 13) }, key, body.subarray(13))); }
  catch { throw new Error('This short link could not be decrypted. It may have been copied incompletely.'); }
  return new TextDecoder().decode(await pipe(packed, new DecompressionStream('deflate-raw')));
}

export async function shortenLink(longUrl, base = SHORTENER_BASE) {
  const { body, key } = await sealLink(longUrl);
  const res = await fetch(`${base}/api/links`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error || `Shortener returned HTTP ${res.status}.`);
  return { url: `${base}/${reply.id}#${key}`, id: reply.id, deleteToken: reply.deleteToken };
}
