const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DEFAULT_ID_LENGTH = 12;
const MAX_ID_ATTEMPTS = 24;
const MAX_LITERAL_PAYLOAD = 2_500_000;
const MAX_RECIPE_PAYLOAD = 65_536;
const MAX_SIZE = 1024 ** 4;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  const configured = String(env.ALLOWED_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!configured.length) return '*';
  return configured.includes(origin) ? origin : configured[0];
}

function corsHeaders(request, env) {
  return {
    'access-control-allow-origin': allowedOrigin(request, env),
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function randomId(length = DEFAULT_ID_LENGTH) {
  const out = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 232) continue;
      out.push(BASE58[b % 58]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function cleanFilename(value) {
  const name = String(value || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  if (!name) throw new Error('A filename is required.');
  if (name.length > 255) throw new Error('Filename is capped at 255 characters.');
  return name;
}

function cleanMime(value) {
  const mime = String(value || 'application/octet-stream').trim().slice(0, 255);
  return mime || 'application/octet-stream';
}

function validateManifest(input) {
  const filename = cleanFilename(input.filename);
  const mime = cleanMime(input.mime);
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) {
    throw new Error('Size must be an integer from 0 bytes through 1 TiB.');
  }

  const kind = String(input.kind || '').toLowerCase();
  const payload = String(input.payload || '');
  if (kind === 'babel') {
    if (!payload.startsWith('/') || !payload.endsWith('/file')) {
      throw new Error('Literal Babel shares must contain a /.../file path.');
    }
    if (payload.length > MAX_LITERAL_PAYLOAD) {
      throw new Error('Literal Babel payload is too large for this registry build.');
    }
  } else if (kind === 'recipe') {
    if (!payload.startsWith('ICXL1:') && !payload.startsWith('ICFMT1:')) {
      if (payload.startsWith('ICFILE1:')) {
        throw new Error('ICFILE1 is a hash locator, not a self-reconstructing public share.');
      }
      throw new Error('Recipe shares must begin with ICXL1: or ICFMT1:.');
    }
    if (payload.length > MAX_RECIPE_PAYLOAD) {
      throw new Error('Recipe payload is too large.');
    }
  } else {
    throw new Error('Share kind must be babel or recipe.');
  }

  const sha256 = input.sha256 == null || input.sha256 === '' ? null : String(input.sha256).toLowerCase();
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('sha256 must be a 64-character hexadecimal digest.');
  }

  return { filename, mime, size, kind, payload, sha256 };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function manifestFingerprint(manifest) {
  return sha256Hex(JSON.stringify({
    version: 1,
    kind: manifest.kind,
    filename: manifest.filename,
    mime: manifest.mime,
    size: manifest.size,
    sha256: manifest.sha256,
    payload: manifest.payload,
  }));
}

function publicBase(request, env) {
  return String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
}

function publicUrl(request, env, row) {
  return `${publicBase(request, env)}/f/${encodeURIComponent(row.id)}/${encodeURIComponent(row.filename)}`;
}

async function rowByFingerprint(env, fingerprint) {
  return env.DB.prepare('SELECT id, filename, mime, size, kind, payload, sha256, created_at, hits FROM shares WHERE fingerprint = ?1')
    .bind(fingerprint).first();
}

async function rowById(env, id) {
  return env.DB.prepare('SELECT id, filename, mime, size, kind, payload, sha256, created_at, hits FROM shares WHERE id = ?1')
    .bind(id).first();
}

async function createShare(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400, corsHeaders(request, env));
  }

  let manifest;
  try {
    manifest = validateManifest(input || {});
  } catch (error) {
    return json({ error: error.message }, 400, corsHeaders(request, env));
  }

  const fingerprint = await manifestFingerprint(manifest);
  const preexisting = await rowByFingerprint(env, fingerprint);
  if (preexisting) {
    return json({
      id: preexisting.id,
      url: publicUrl(request, env, preexisting),
      deduplicated: true,
      idAttempts: 0,
    }, 200, corsHeaders(request, env));
  }

  const createdAt = Date.now();
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
    // If the extraordinarily unlikely event of repeated ID collisions occurs,
    // widen the pointer after every eight failed attempts.
    const length = DEFAULT_ID_LENGTH + Math.floor((attempt - 1) / 8) * 2;
    const id = randomId(length);
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO shares
        (id, fingerprint, filename, mime, size, kind, payload, sha256, created_at, hits)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
    `).bind(
      id,
      fingerprint,
      manifest.filename,
      manifest.mime,
      manifest.size,
      manifest.kind,
      manifest.payload,
      manifest.sha256,
      createdAt,
    ).run();

    if ((result.meta?.changes || 0) === 1) {
      return json({
        id,
        url: publicUrl(request, env, { id, filename: manifest.filename }),
        deduplicated: false,
        idAttempts: attempt,
      }, 201, corsHeaders(request, env));
    }

    // INSERT OR IGNORE can fail because either the random ID collided or an
    // identical share won the fingerprint race. Resolve the latter first so
    // simultaneous identical requests converge on one public pointer.
    const sameManifest = await rowByFingerprint(env, fingerprint);
    if (sameManifest) {
      return json({
        id: sameManifest.id,
        url: publicUrl(request, env, sameManifest),
        deduplicated: true,
        idAttempts: attempt,
      }, 200, corsHeaders(request, env));
    }
    // Otherwise the ID itself overlapped an unrelated row. Retry atomically.
  }

  return json({ error: 'Could not allocate a unique public pointer after repeated collision retries.' }, 503, corsHeaders(request, env));
}

async function getShare(request, env, id) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{8,32}$/.test(id)) {
    return json({ error: 'Invalid share pointer.' }, 400, corsHeaders(request, env));
  }
  const row = await rowById(env, id);
  if (!row) return json({ error: 'Share not found.' }, 404, corsHeaders(request, env));

  return json({
    version: 1,
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    payload: row.payload,
    sha256: row.sha256,
    createdAt: row.created_at,
    hits: row.hits,
    url: publicUrl(request, env, row),
  }, 200, {
    ...corsHeaders(request, env),
    'cache-control': 'public, max-age=300',
  });
}

async function resolvePrettyLink(request, env, ctx, id, requestedName) {
  const row = await rowById(env, id);
  if (!row) return new Response('Infinite Corridor share not found.', { status: 404 });

  const canonicalName = row.filename;
  if (requestedName !== canonicalName) {
    return Response.redirect(publicUrl(request, env, row), 301);
  }

  ctx.waitUntil(env.DB.prepare('UPDATE shares SET hits = hits + 1 WHERE id = ?1').bind(id).run());

  const appUrl = String(env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl) {
    return new Response('Share registry is missing APP_URL configuration.', { status: 500 });
  }
  const apiOrigin = new URL(request.url).origin;
  const target = `${appUrl}/share.html?api=${encodeURIComponent(apiOrigin)}#${encodeURIComponent(id)}/${encodeURIComponent(canonicalName)}`;
  return Response.redirect(target, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === 'POST' && path === '/api/shares') {
      return createShare(request, env);
    }

    const apiMatch = path.match(/^\/api\/shares\/([1-9A-HJ-NP-Za-km-z]{8,32})$/);
    if (request.method === 'GET' && apiMatch) {
      return getShare(request, env, apiMatch[1]);
    }

    const prettyMatch = path.match(/^\/f\/([1-9A-HJ-NP-Za-km-z]{8,32})\/(.+)$/);
    if (request.method === 'GET' && prettyMatch) {
      let filename;
      try { filename = decodeURIComponent(prettyMatch[2]); }
      catch { return new Response('Invalid filename encoding.', { status: 400 }); }
      return resolvePrettyLink(request, env, ctx, prettyMatch[1], filename);
    }

    if (request.method === 'GET' && path === '/') {
      return json({
        service: 'Infinite Corridor public pointer registry',
        version: 1,
        endpoints: ['POST /api/shares', 'GET /api/shares/:id', 'GET /f/:id/:filename'],
        pointerAlphabet: 'Base58',
        defaultPointerLength: DEFAULT_ID_LENGTH,
        collisionRetries: MAX_ID_ATTEMPTS,
      });
    }

    return new Response('Not found.', { status: 404 });
  },
};
