import { bytesToPath, normalizePath, estimatedDepth, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const MAX_LITERAL_BYTES = 64 * 1024;
const MAX_LOCAL_FILE_BYTES = 256 * 1024 ** 3; // 256 GiB
const HASH_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MiB
let cancelHash = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(buffer) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
}

async function contentLocator(file, onProgress) {
  const chunkHashes = [];
  const totalChunks = Math.ceil(file.size / HASH_CHUNK_BYTES);

  for (let i = 0; i < totalChunks; i++) {
    if (cancelHash) throw new DOMException('Cancelled', 'AbortError');
    const start = i * HASH_CHUNK_BYTES;
    const end = Math.min(file.size, start + HASH_CHUNK_BYTES);
    const chunk = await file.slice(start, end).arrayBuffer();
    chunkHashes.push(await sha256(chunk));
    if (onProgress) onProgress(i + 1, totalChunks, end);
    if ((i + 1) % 8 === 0) await new Promise(requestAnimationFrame);
  }

  const manifest = new Uint8Array(chunkHashes.length * 32);
  chunkHashes.forEach((digest, i) => manifest.set(digest, i * 32));
  const root = await sha256(manifest);
  return `ICFILE1:${file.size}:${HASH_CHUNK_BYTES}:${hex(root)}`;
}

function exactResult(file, bytes) {
  const start = performance.now();
  const path = bytesToPath(bytes);
  const ms = performance.now() - start;
  const depth = normalizePath(path).length;
  const pathDisplay = path.length > 12000
    ? `${path.slice(0, 6000)}\n… ${path.length - 12000} characters omitted …\n${path.slice(-6000)}`
    : path;

  $('#exact-result').innerHTML = `
    <div class="result-head"><div><span class="eyebrow">${escapeHtml(file.name)}</span><h3>${formatBytes(file.size)} · ${depth.toLocaleString()} levels</h3></div><span class="pill">${ms.toFixed(1)} ms</span></div>
    <label>Literal Corridor address</label><textarea id="large-file-address" class="mono result-path" readonly>${escapeHtml(pathDisplay)}</textarea>
    ${path.length > 12000 ? '<p class="muted">Displayed address is abbreviated. Copy Address copies the complete path.</p>' : ''}
    <div class="button-row"><button id="large-file-copy">Copy address</button></div>`;

  $('#large-file-copy').onclick = async () => {
    await navigator.clipboard.writeText(path);
    $('#large-file-copy').textContent = 'Copied';
    setTimeout(() => { $('#large-file-copy').textContent = 'Copy address'; }, 900);
  };
}

function prepareLargeFile(file) {
  const depth = estimatedDepth(file.size);
  $('#exact-result').innerHTML = `
    <div class="result-head"><div><span class="eyebrow">Large local file</span><h3>${escapeHtml(file.name)} · ${formatBytes(file.size)}</h3></div><span class="pill">up to 256 GiB</span></div>
    <div class="notice warn">A literal Babel path for this file would require roughly <strong>${depth.toLocaleString()}</strong> Corridor levels, so materializing the literal path is not practical. The large-file locator below fingerprints the entire file in 16 MiB chunks without loading the whole file into memory.</div>
    <div class="button-row"><button id="large-file-hash">Calculate content locator</button><button id="large-file-cancel" class="secondary" disabled>Cancel</button></div>
    <progress id="large-file-progress" max="100" value="0" style="width:100%;margin-top:14px"></progress>
    <div id="large-file-status" class="muted" style="margin-top:8px">Ready to scan ${formatBytes(file.size)} locally.</div>`;

  $('#large-file-hash').onclick = async () => {
    cancelHash = false;
    const hashButton = $('#large-file-hash');
    const cancelButton = $('#large-file-cancel');
    const progress = $('#large-file-progress');
    const status = $('#large-file-status');
    hashButton.disabled = true;
    cancelButton.disabled = false;

    try {
      const locator = await contentLocator(file, (done, total, processed) => {
        const pct = total ? (done / total) * 100 : 100;
        progress.value = pct;
        status.textContent = `${pct.toFixed(2)}% · ${formatBytes(processed)} / ${formatBytes(file.size)} · ${done.toLocaleString()} / ${total.toLocaleString()} chunks`;
      });

      progress.value = 100;
      status.textContent = 'Content fingerprint complete.';
      const box = document.createElement('div');
      box.innerHTML = `<label style="margin-top:14px">ICFILE1 large-file locator</label><textarea id="large-file-locator" class="mono result-path" readonly>${locator}</textarea><div class="button-row"><button id="large-file-copy-locator">Copy locator</button></div><p class="muted">ICFILE1 is an Infinite Corridor large-file extension. It identifies the file by a SHA-256 tree-style fingerprint; it is not the impossible-to-materialize literal Babel path.</p>`;
      $('#exact-result').appendChild(box);
      $('#large-file-copy-locator').onclick = async () => {
        await navigator.clipboard.writeText(locator);
        $('#large-file-copy-locator').textContent = 'Copied';
        setTimeout(() => { $('#large-file-copy-locator').textContent = 'Copy locator'; }, 900);
      };
    } catch (error) {
      status.textContent = error?.name === 'AbortError' ? 'Fingerprint cancelled.' : `Error: ${error.message}`;
    } finally {
      hashButton.disabled = false;
      cancelButton.disabled = true;
    }
  };

  $('#large-file-cancel').onclick = () => { cancelHash = true; };
}

function installLargeFileFinder() {
  const input = $('#file-input');
  const meta = $('#file-meta');
  if (!input || !meta) return;

  meta.textContent = 'Local file support: up to 256 GiB. Literal Corridor paths are generated directly up to 64 KiB; larger files use a streamed content locator.';

  input.onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    meta.textContent = `${file.name} · ${formatBytes(file.size)} · estimated literal depth ${estimatedDepth(file.size).toLocaleString()} levels`;

    if (file.size > MAX_LOCAL_FILE_BYTES) {
      $('#exact-result').innerHTML = `<div class="notice error"><strong>${escapeHtml(file.name)}</strong><br>${formatBytes(file.size)} exceeds the 256 GiB local-file limit.</div>`;
      return;
    }

    if (file.size <= MAX_LITERAL_BYTES) {
      exactResult(file, new Uint8Array(await file.arrayBuffer()));
      return;
    }

    prepareLargeFile(file);
  };
}

installLargeFileFinder();
