const $ = s => document.querySelector(s);
const MAX_LOCAL_LITERAL = 64 * 1024;
let pathWorker = null;
let pathJob = 0;
const pathJobs = new Map();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
  }[c]));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function normalizeApi(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) throw new Error('Enter the deployed share Worker URL first.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('Share API must use HTTPS.');
  return url.origin + url.pathname.replace(/\/$/, '');
}

function getApiBase() {
  return normalizeApi($('#share-api-base').value);
}

function saveApiBase() {
  const base = getApiBase();
  localStorage.setItem('ic-share-api-base', base);
  $('#share-api-status').textContent = `Saved ${base}`;
}

function inferMime(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  const map = {
    pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
    json:'application/json', txt:'text/plain', md:'text/markdown', csv:'text/csv',
    zip:'application/zip', mkv:'video/x-matroska', mp4:'video/mp4', mp3:'audio/mpeg',
    flac:'audio/flac', gguf:'application/octet-stream', safetensors:'application/octet-stream'
  };
  return map[ext] || 'application/octet-stream';
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function ensurePathWorker() {
  if (pathWorker) return pathWorker;
  pathWorker = new Worker(new URL('./babel-path-worker.js?v=20260812share1', import.meta.url), { type:'module' });
  pathWorker.onmessage = event => {
    const msg = event.data || {}, job = pathJobs.get(msg.id);
    if (!job) return;
    pathJobs.delete(msg.id);
    if (msg.ok) job.resolve(msg);
    else job.reject(new Error(msg.error || 'Babel path calculation failed.'));
  };
  pathWorker.onerror = event => {
    const error = new Error(event.message || 'Babel path worker crashed.');
    for (const job of pathJobs.values()) job.reject(error);
    pathJobs.clear();
    pathWorker.terminate();
    pathWorker = null;
  };
  return pathWorker;
}

function calculatePath(bytes) {
  return new Promise((resolve, reject) => {
    const id = ++pathJob, copy = bytes.slice();
    pathJobs.set(id, { resolve, reject });
    ensurePathWorker().postMessage({ id, buffer: copy.buffer }, [copy.buffer]);
  });
}

async function createShare(manifest) {
  const api = getApiBase();
  const response = await fetch(`${api}/api/shares`, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(manifest),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Share registry returned HTTP ${response.status}.`);
  return body;
}

function renderCreatedShare(result, target) {
  const retryText = result.idAttempts > 1
    ? `${result.idAttempts} atomic allocation attempts were needed because a short pointer overlapped.`
    : result.idAttempts === 1
      ? 'The first short pointer allocation succeeded without overlap.'
      : 'An identical manifest already existed, so the existing pointer was reused.';
  target.innerHTML = `<div class="notice">
    <strong>${result.deduplicated ? 'Existing public pointer reused' : 'Public pointer created'}</strong><br>
    <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer" class="mono">${escapeHtml(result.url)}</a>
    <div class="muted" style="margin-top:8px">${escapeHtml(retryText)}</div>
    <div class="button-row"><button class="secondary share-copy-link">Copy public link</button><button class="secondary share-open-link">Open public link</button></div>
  </div>`;
  target.querySelector('.share-copy-link').onclick = async event => {
    await navigator.clipboard.writeText(result.url);
    const button = event.currentTarget, old = button.textContent;
    button.textContent = 'Copied'; setTimeout(() => button.textContent = old, 900);
  };
  target.querySelector('.share-open-link').onclick = () => window.open(result.url, '_blank', 'noopener,noreferrer');
}

async function shareLocalFile() {
  const file = $('#share-local-file').files?.[0];
  const status = $('#share-local-status'), result = $('#share-local-result');
  if (!file) throw new Error('Choose a local file first.');
  if (file.size > MAX_LOCAL_LITERAL) {
    throw new Error(`This pointer-only build can share arbitrary local files up to ${formatBytes(MAX_LOCAL_LITERAL)} as literal Babel objects. Larger arbitrary files need R2/peer storage; ICFILE1 hashes alone are not reconstructable.`);
  }

  status.textContent = `Reading ${file.name} locally…`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  status.textContent = `Calculating the self-contained Babel path for ${formatBytes(file.size)}…`;
  const [pathResult, hash] = await Promise.all([
    calculatePath(bytes),
    sha256Hex(bytes),
  ]);
  status.textContent = 'Registering the long Babel path behind a collision-safe short pointer…';
  const created = await createShare({
    filename: file.name,
    mime: file.type || inferMime(file.name),
    size: file.size,
    kind: 'babel',
    payload: pathResult.path,
    sha256: hash,
  });
  renderCreatedShare(created, result);
  status.textContent = `Ready. The registry stores the pointer manifest; the public URL does not expose the long Babel path.`;
}

function parseRecipeSize(payload) {
  const parts = payload.split(':');
  if ((parts[0] !== 'ICXL1' && parts[0] !== 'ICFMT1') || !/^\d+$/.test(parts[1] || '')) return null;
  const n = Number(parts[1]);
  return Number.isSafeInteger(n) ? n : null;
}

async function shareAddress() {
  const payload = $('#share-address').value.trim();
  const filename = $('#share-address-name').value.trim();
  const status = $('#share-address-status'), result = $('#share-address-result');
  if (!filename) throw new Error('Enter the filename that should appear at the end of the public link.');
  if (!payload) throw new Error('Paste a literal Babel path or ICXL1/ICFMT1 recipe.');
  if (payload.startsWith('ICFILE1:')) throw new Error('ICFILE1 is only a content hash locator and cannot recreate an arbitrary file for a recipient.');

  let kind, size;
  if (payload.startsWith('/')) {
    kind = 'babel';
    size = Number($('#share-address-size').value);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Enter the original byte size for a literal Babel path.');
  } else if (payload.startsWith('ICXL1:') || payload.startsWith('ICFMT1:')) {
    kind = 'recipe';
    size = parseRecipeSize(payload);
    if (size == null) throw new Error('Could not read a valid byte size from the recipe.');
  } else {
    throw new Error('Only literal /.../file paths and ICXL1/ICFMT1 recipes are publicly shareable in this build.');
  }

  status.textContent = 'Creating collision-safe public pointer…';
  const created = await createShare({
    filename,
    mime: inferMime(filename),
    size,
    kind,
    payload,
    sha256: $('#share-address-sha').value.trim() || null,
  });
  renderCreatedShare(created, result);
  status.textContent = 'Ready.';
}

function installUi() {
  const panel = $('#panel-share');
  if (!panel) return;
  const savedApi = localStorage.getItem('ic-share-api-base') || '';
  panel.innerHTML = `<div class="card">
    <span class="eyebrow">Short URL → collision-safe manifest → Babel object</span>
    <h3>Public sharing</h3>
    <p class="help">The public registry stores a tiny manifest mapping a Base58 short pointer to a self-contained Babel path or reproducible XL recipe. The filename remains at the end of the public URL. D1 uniqueness constraints prevent simultaneous attempts from overwriting one another.</p>
    <label for="share-api-base">Share Worker URL</label>
    <div class="path-wrap"><input id="share-api-base" class="mono" type="url" placeholder="https://infinite-corridor-share.example.workers.dev" value="${escapeHtml(savedApi)}"><button id="share-save-api" class="secondary">Save endpoint</button></div>
    <div id="share-api-status" class="muted" style="margin-top:8px">${savedApi ? `Using ${escapeHtml(savedApi)}` : 'Deploy the share Worker, then save its HTTPS URL here once.'}</div>
  </div>

  <div class="grid-2">
    <div class="card">
      <span class="eyebrow">Local file → literal Babel → short pointer</span>
      <h3>Share a local file</h3>
      <p class="help">Nothing is uploaded as a conventional file. For this first pointer-only build, arbitrary local files up to ${formatBytes(MAX_LOCAL_LITERAL)} are converted to their literal self-contained Babel path, and that path is hidden behind the short public pointer.</p>
      <input id="share-local-file" class="input" type="file">
      <div class="button-row"><button id="share-local-create">Create public link</button></div>
      <div id="share-local-status" class="muted" style="margin-top:10px">Ready.</div>
      <div id="share-local-result" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <span class="eyebrow">Existing address → short pointer</span>
      <h3>Share a Babel / XL address</h3>
      <label for="share-address-name">Filename shown in the URL</label>
      <input id="share-address-name" type="text" placeholder="cheeseburger.mkv">
      <label for="share-address">Literal Babel path or recipe</label>
      <textarea id="share-address" class="mono" placeholder="/AA/.../file or ICXL1:..."></textarea>
      <div class="grid-2">
        <div><label for="share-address-size">Original size for literal paths</label><input id="share-address-size" type="number" min="0" placeholder="55878"></div>
        <div><label for="share-address-sha">SHA-256 (optional)</label><input id="share-address-sha" class="mono" type="text" placeholder="64 hex characters"></div>
      </div>
      <div class="button-row"><button id="share-address-create">Create public link</button></div>
      <div id="share-address-status" class="muted" style="margin-top:10px">Ready.</div>
      <div id="share-address-result" style="margin-top:12px"></div>
    </div>
  </div>

  <div class="card help">
    <h3>Overlap handling</h3>
    <p>Short IDs start at 12 Base58 characters. D1 stores the ID as a primary key and the complete manifest fingerprint as a second unique key. If two unrelated allocation attempts happen to choose the same short ID, the losing insert cannot overwrite the existing row and automatically retries. If two identical manifests are submitted concurrently, only one wins the fingerprint race and both clients receive that same pointer. After every eight true ID collisions the generated ID widens by two characters, with a hard limit of 24 allocation attempts.</p>
    <p><code>ICFILE1:</code> values are intentionally rejected for public reconstruction because a hash does not carry the original arbitrary bytes. A later R2 or peer-storage layer can add large arbitrary files without changing the <code>/f/&lt;pointer&gt;/&lt;filename&gt;</code> public URL format.</p>
  </div>`;

  $('#share-save-api').onclick = () => {
    try { saveApiBase(); }
    catch (error) { $('#share-api-status').textContent = error.message; }
  };
  $('#share-local-create').onclick = () => shareLocalFile().catch(error => {
    $('#share-local-status').textContent = error.message;
    $('#share-local-result').innerHTML = '';
  });
  $('#share-address-create').onclick = () => shareAddress().catch(error => {
    $('#share-address-status').textContent = error.message;
    $('#share-address-result').innerHTML = '';
  });
}

installUi();
