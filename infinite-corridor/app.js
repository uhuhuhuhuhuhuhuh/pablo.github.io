import {
  ALPHABET, DIRECTORY_OBJECTS, bytesToPath, pathToBytes, normalizePath,
  directoryName, estimatedDepth, formatBytes
} from './codec.js';

const $ = (s) => document.querySelector(s);
const MAX_EXACT_BYTES = 64 * 1024;
let explorerSegments = [];
let explorerPage = 0;
let lastResultBytes = null;
let lastResultPath = '';

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

function setTab(name) {
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.toggle('active', el.id === `panel-${name}`));
}

function textPreview(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const printable = [...text.slice(0, 1024)].filter(c => c === '\n' || c === '\r' || c === '\t' || c.charCodeAt(0) >= 32).length;
    const total = Math.max(1, [...text.slice(0, 1024)].length);
    return printable / total > 0.85 ? text.slice(0, 4096) : '(binary or mostly non-printable data)';
  } catch { return '(unable to decode as UTF-8)'; }
}

function hexPreview(bytes, limit = 256) {
  return [...bytes.slice(0, limit)].map(b => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > limit ? ' …' : '');
}

function showExactResult(bytes, label = 'Generated object') {
  if (bytes.length > MAX_EXACT_BYTES) {
    const depth = estimatedDepth(bytes.length);
    $('#exact-result').innerHTML = `<div class="notice warn"><strong>${label}</strong><br>This object is ${formatBytes(bytes.length)} and would require roughly ${depth.toLocaleString()} Corridor levels. Exact conversion is capped at ${formatBytes(MAX_EXACT_BYTES)} in this browser build to avoid locking the tab.</div>`;
    return;
  }
  const start = performance.now();
  const path = bytesToPath(bytes);
  const ms = performance.now() - start;
  lastResultBytes = bytes;
  lastResultPath = path;
  const depth = normalizePath(path).length;
  const pathDisplay = path.length > 12000 ? `${path.slice(0, 6000)}\n… ${path.length - 12000} characters omitted …\n${path.slice(-6000)}` : path;
  $('#exact-result').innerHTML = `
    <div class="result-head"><div><span class="eyebrow">${label}</span><h3>${formatBytes(bytes.length)} · ${depth.toLocaleString()} levels</h3></div><span class="pill">${ms.toFixed(1)} ms</span></div>
    <label>Corridor address</label><textarea class="mono result-path" readonly>${pathDisplay}</textarea>
    ${path.length > 12000 ? '<p class="muted">The displayed address is abbreviated. Copy Address still copies the complete path.</p>' : ''}
    <div class="button-row"><button id="copy-path">Copy address</button><button id="download-result" class="secondary">Download file</button><button id="explore-result" class="secondary">Open in Explorer</button></div>
    <div class="preview-grid"><div><label>UTF-8 preview</label><pre>${escapeHtml(textPreview(bytes))}</pre></div><div><label>Hex preview</label><pre>${hexPreview(bytes)}</pre></div></div>`;
  $('#copy-path').onclick = async () => { await navigator.clipboard.writeText(lastResultPath); toast('Full address copied'); };
  $('#download-result').onclick = () => downloadBytes(lastResultBytes, 'corridor-file.bin');
  $('#explore-result').onclick = () => { explorerSegments = normalizePath(lastResultPath); explorerPage = 0; renderExplorer(); setTab('explore'); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function parseHex(input) {
  const cleaned = input.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!cleaned) return new Uint8Array();
  if (cleaned.length % 2) throw new Error('Hex input must contain complete byte pairs.');
  return Uint8Array.from(cleaned.match(/.{2}/g).map(x => parseInt(x, 16)));
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#text-find').onclick = () => showExactResult(new TextEncoder().encode($('#text-input').value), 'Exact text');
$('#hex-find').onclick = () => {
  try { showExactResult(parseHex($('#hex-input').value), 'Exact bytes'); }
  catch (e) { $('#exact-result').innerHTML = `<div class="notice error">${escapeHtml(e.message)}</div>`; }
};
$('#file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const meta = $('#file-meta');
  meta.textContent = `${file.name} · ${formatBytes(file.size)} · estimated depth ${estimatedDepth(file.size).toLocaleString()}`;
  if (file.size > MAX_EXACT_BYTES) {
    $('#exact-result').innerHTML = `<div class="notice warn">${escapeHtml(file.name)} is larger than the ${formatBytes(MAX_EXACT_BYTES)} exact-conversion safety cap. The browser can still estimate its Corridor depth, but this build will not generate the enormous full path.</div>`;
    return;
  }
  showExactResult(new Uint8Array(await file.arrayBuffer()), file.name);
};

function renderExplorer() {
  const pageSize = 100;
  const start = explorerPage * pageSize;
  const end = Math.min(DIRECTORY_OBJECTS, start + pageSize);
  const path = '/' + explorerSegments.join('/');
  $('#explorer-path').value = path || '/';
  $('#explorer-depth').textContent = `${explorerSegments.length.toLocaleString()} levels deep`;
  const dirs = [];
  for (let i = start; i < end; i++) {
    const name = directoryName(i);
    dirs.push(`<button class="dir" data-dir="${i}"><span class="folder-icon">▰</span><span>${escapeHtml(name).replaceAll(' ', '&nbsp;')}</span><small>#${i}</small></button>`);
  }
  $('#directory-grid').innerHTML = dirs.join('');
  $('#page-label').textContent = `${(start + 1).toLocaleString()}–${end.toLocaleString()} of 4,900`;
  $('#prev-page').disabled = explorerPage === 0;
  $('#next-page').disabled = end >= DIRECTORY_OBJECTS;
  document.querySelectorAll('.dir').forEach(btn => btn.onclick = () => {
    explorerSegments.push(directoryName(Number(btn.dataset.dir));
    explorerPage = 0;
    renderExplorer();
    updateHash();
  });
  const bytes = (() => {
    try { return pathToBytes('/' + explorerSegments.join('/') + '/file'); }
    catch { return new Uint8Array(); }
  })();
  $('#file-size').textContent = formatBytes(bytes.length);
  $('#file-text-preview').textContent = textPreview(bytes).slice(0, 1000);
  $('#file-hex-preview').textContent = hexPreview(bytes, 128) || '(empty file)';
}

function updateHash() {
  if (explorerSegments.length < 200) history.replaceState(null, '', '#p=' + encodeURIComponent(explorerSegments.join('/')));
}

$('#prev-page').onclick = () => { if (explorerPage > 0) { explorerPage--; renderExplorer(); } };
$('#next-page').onclick = () => { if ((explorerPage + 1) * 100 < DIRECTORY_OBJECTS) { explorerPage++; renderExplorer(); } };
$('#up-dir').onclick = () => { explorerSegments.pop(); explorerPage = 0; renderExplorer(); updateHash(); };
$('#root-dir').onclick = () => { explorerSegments = []; explorerPage = 0; renderExplorer(); updateHash(); };
$('#go-path').onclick = () => {
  try {
    explorerSegments = normalizePath($('#explorer-path').value);
    explorerSegments.forEach(s => {
      if ([...s].length !== 2 || [...s].some(c => !ALPHABET.includes(c))) throw new Error(`Invalid segment ${s}`);
    });
    explorerPage = 0;
    renderExplorer();
    updateHash();
  } catch (e) { toast(e.message); }
};
$('#download-current').onclick = () => downloadBytes(pathToBytes('/' + explorerSegments.join('/') + '/file'), 'corridor-file.bin');

function renderDecode(bytes, segments) {
  $('#decode-result').innerHTML = `<div class="result-head"><div><span class="eyebrow">Decoded object</span><h3>${formatBytes(bytes.length)} · ${segments.length.toLocaleString()} levels</h3></div></div><div class="button-row"><button id="decode-download">Download</button><button id="decode-open" class="secondary">Open in Explorer</button></div><div class="preview-grid"><div><label>UTF-8 preview</label><pre>${escapeHtml(textPreview(bytes))}</pre></div><div><label>Hex preview</label><pre>${hexPreview(bytes, 128)}</pre></div></div>`;
  $('#decode-download').onclick = () => downloadBytes(bytes, 'corridor-decoded.bin');
  $('#decode-open').onclick = () => { explorerSegments = segments; explorerPage = 0; renderExplorer(); setTab('explore'); };
}

$('#decode-button').onclick = () => {
  try {
    const segments = normalizePath($('#decode-path').value);
    const bytes = pathToBytes($('#decode-path').value);
    renderDecode(bytes, segments);
  } catch (e) {
    $('#decode-result').innerHTML = `<div class="notice error">${escapeHtml(e.message)}</div>`;
  }
};

// Regex generation is implemented exclusively in enhancements.js. Keeping it out of
// this base module prevents the old 32-repeat parser from racing the deep-search engine.

document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => setTab(el.dataset.tab));

const hp = new URLSearchParams(location.hash.slice(1)).get('p');
if (hp) {
  try { explorerSegments = normalizePath(decodeURIComponent(hp)); }
  catch {}
}
renderExplorer();
