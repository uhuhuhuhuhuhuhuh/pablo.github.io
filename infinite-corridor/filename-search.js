import { bytesToPath, normalizePath, estimatedDepth, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const MAX_LITERAL_BYTES = 64 * 1024;
const MAX_LOCAL_FILE_BYTES = 256 * 1024 ** 3;
const HASH_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 10000;

let entries = [];
let currentResults = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function basename(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

function filenameFromUrl(value) {
  try {
    const url = new URL(value);
    return decodeURIComponent(basename(url.pathname)) || url.hostname;
  } catch {
    return basename(value);
  }
}

function toSize(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeCatalogEntry(value, sourceLabel = 'Imported catalog') {
  if (typeof value === 'string') {
    const line = value.trim();
    if (!line) return null;
    const isUrl = /^https?:\/\//i.test(line);
    return {
      kind: 'catalog',
      name: isUrl ? filenameFromUrl(line) : basename(line),
      path: isUrl ? filenameFromUrl(line) : line,
      url: isUrl ? line : '',
      size: null,
      source: sourceLabel,
    };
  }

  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || value.href || value.download_url || value.downloadUrl || '');
  const path = String(value.path || value.relativePath || value.relative_path || value.filename || value.name || (url ? filenameFromUrl(url) : ''));
  const name = String(value.name || value.filename || basename(path) || (url ? filenameFromUrl(url) : ''));
  if (!name) return null;

  return {
    kind: 'catalog',
    name,
    path: path || name,
    url,
    size: toSize(value.size ?? value.bytes ?? value.contentLength ?? value.content_length),
    source: String(value.source || sourceLabel),
  };
}

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(value.trim()); value = ''; }
    else value += ch;
  }
  out.push(value.trim());
  return out;
}

function parseCatalogText(text, filename = 'catalog.txt', sourceLabel = 'Imported catalog') {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (filename.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.files) ? parsed.files : (Array.isArray(parsed.entries) ? parsed.entries : [parsed]));
    return list.map(item => normalizeCatalogEntry(item, sourceLabel)).filter(Boolean);
  }

  if (filename.toLowerCase().endsWith('.csv')) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const first = parseCsvLine(lines[0]);
    const headerNames = first.map(x => x.toLowerCase());
    const known = ['name','filename','path','url','href','size','bytes','source'];
    const hasHeader = headerNames.some(x => known.includes(x));
    const start = hasHeader ? 1 : 0;
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (hasHeader) {
        const obj = {};
        headerNames.forEach((key, idx) => { obj[key] = cols[idx] ?? ''; });
        rows.push(normalizeCatalogEntry(obj, sourceLabel));
      } else {
        rows.push(normalizeCatalogEntry({ path: cols[0] || '', url: cols[1] || '', size: cols[2] || '' }, sourceLabel));
      }
    }
    return rows.filter(Boolean);
  }

  return trimmed.split(/\r?\n/).map(line => normalizeCatalogEntry(line, sourceLabel)).filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.kind === 'local'
      ? `local\0${item.path}\0${item.size}`
      : `catalog\0${item.name}\0${item.path}\0${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compileRegex(raw, caseInsensitive) {
  raw = raw.trim();
  if (!raw) throw new Error('Enter a filename regex.');

  let source = raw;
  let flags = caseInsensitive ? 'i' : '';
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/');
    if (last > 0) {
      source = raw.slice(1, last);
      flags = raw.slice(last + 1);
      if (caseInsensitive && !flags.includes('i')) flags += 'i';
    }
  }

  flags = [...new Set(flags.replace(/[gy]/g, '').split(''))].join('');
  return new RegExp(source, flags);
}

function formatMaybeSize(size) {
  return size === null || size === undefined ? 'size unknown' : formatBytes(size);
}

function updateIndexStatus(extra = '') {
  const localCount = entries.filter(x => x.kind === 'local').length;
  const catalogCount = entries.length - localCount;
  const el = $('#filename-index-status');
  if (!el) return;
  el.textContent = `${entries.length.toLocaleString()} indexed names · ${localCount.toLocaleString()} local · ${catalogCount.toLocaleString()} catalog${extra ? ` · ${extra}` : ''}`;
}

function renderEmpty(message) {
  $('#regex-results').innerHTML = `<div class="notice">${escapeHtml(message)}</div>`;
}

function resultActions(item, index) {
  if (item.kind === 'local') {
    return `<div class="button-row" style="margin-top:0"><button class="secondary filename-map" data-i="${index}">Map real bytes</button></div>`;
  }
  if (item.url) {
    return `<div class="button-row" style="margin-top:0"><button class="secondary filename-open" data-i="${index}">Open source</button><button class="secondary filename-copy-url" data-i="${index}">Copy URL</button></div>`;
  }
  return '<span class="pill">name only</span>';
}

function renderResults(results, totalMatches, searchedCount) {
  currentResults = results;
  const summary = `<div class="notice"><strong>${totalMatches.toLocaleString()} matching filenames</strong><br><span class="muted">Showing ${results.length.toLocaleString()} of ${totalMatches.toLocaleString()} matches from ${searchedCount.toLocaleString()} indexed entries. Regex is applied to real indexed names; it does not synthesize missing filenames.</span></div>`;
  const rows = results.map((item, idx) => {
    const detail = item.path && item.path !== item.name ? item.path : (item.url || item.source || '');
    const depth = item.size === null || item.size === undefined ? '' : ` · ~${estimatedDepth(item.size).toLocaleString()} literal levels`;
    return `<article class="regex-result filename-result" data-result="${idx}">
      <div><span class="eyebrow">${item.kind === 'local' ? 'Local file' : 'Catalog entry'}</span><strong>${escapeHtml(item.name)}</strong><div class="regex-meta"><span>${escapeHtml(formatMaybeSize(item.size))}</span><span>${escapeHtml(item.source || '')}${depth}</span></div></div>
      <code title="${escapeHtml(detail)}">${escapeHtml(detail || item.name)}</code>
      ${resultActions(item, idx)}
      <div class="filename-map-output" data-output="${idx}" style="grid-column:1/-1"></div>
    </article>`;
  }).join('');
  $('#regex-results').innerHTML = summary + rows;

  document.querySelectorAll('.filename-open').forEach(btn => {
    btn.onclick = () => {
      const item = currentResults[Number(btn.dataset.i)];
      window.open(item.url, '_blank', 'noopener,noreferrer');
    };
  });

  document.querySelectorAll('.filename-copy-url').forEach(btn => {
    btn.onclick = async () => {
      const item = currentResults[Number(btn.dataset.i)];
      await navigator.clipboard.writeText(item.url);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 900);
    };
  });

  document.querySelectorAll('.filename-map').forEach(btn => {
    btn.onclick = () => mapLocalResult(Number(btn.dataset.i), btn);
  });
}

async function mapLocalResult(index, button) {
  const item = currentResults[index];
  if (!item?.file) return;
  const output = document.querySelector(`[data-output="${index}"]`);
  if (!output) return;

  if (item.file.size > MAX_LOCAL_FILE_BYTES) {
    output.innerHTML = `<div class="notice error">${escapeHtml(item.name)} exceeds the 256 GiB local-file mapping limit.</div>`;
    return;
  }

  button.disabled = true;
  try {
    if (item.file.size <= MAX_LITERAL_BYTES) {
      output.innerHTML = '<div class="notice">Reading file and calculating literal Corridor address…</div>';
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const path = bytesToPath(bytes);
      const depth = normalizePath(path).length;
      const shown = path.length > 12000 ? `${path.slice(0, 6000)}\n… ${path.length - 12000} characters omitted …\n${path.slice(-6000)}` : path;
      output.innerHTML = `<div class="notice"><strong>Real file bytes mapped</strong><br>${formatBytes(item.file.size)} · ${depth.toLocaleString()} levels</div><label style="margin-top:10px">Literal Corridor address</label><textarea class="mono result-path" readonly>${escapeHtml(shown)}</textarea><div class="button-row"><button class="secondary filename-copy-path">Copy full address</button></div>`;
      output.querySelector('.filename-copy-path').onclick = async (event) => {
        await navigator.clipboard.writeText(path);
        event.currentTarget.textContent = 'Copied';
      };
      return;
    }

    const token = { cancelled: false };
    output.innerHTML = `<div class="notice warn">The real file is ${formatBytes(item.file.size)}. Its literal Babel path would require roughly ${estimatedDepth(item.file.size).toLocaleString()} levels, so the browser will calculate an ICFILE1 content locator instead.</div><progress class="filename-map-progress" max="100" value="0" style="width:100%;margin-top:12px"></progress><div class="muted filename-map-status" style="margin-top:8px">Starting…</div><div class="button-row"><button class="secondary filename-cancel-map">Cancel</button></div>`;
    output.querySelector('.filename-cancel-map').onclick = () => { token.cancelled = true; };
    const progress = output.querySelector('.filename-map-progress');
    const status = output.querySelector('.filename-map-status');
    const locator = await contentLocator(item.file, token, (done, total, processed) => {
      const pct = total ? (done / total) * 100 : 100;
      progress.value = pct;
      status.textContent = `${pct.toFixed(2)}% · ${formatBytes(processed)} / ${formatBytes(item.file.size)} · ${done.toLocaleString()} / ${total.toLocaleString()} chunks`;
    });
    output.innerHTML = `<div class="notice"><strong>Real file fingerprint complete</strong><br>${formatBytes(item.file.size)} · estimated literal depth ${estimatedDepth(item.file.size).toLocaleString()} levels</div><label style="margin-top:10px">ICFILE1 locator</label><textarea class="mono result-path" readonly>${locator}</textarea><div class="button-row"><button class="secondary filename-copy-locator">Copy locator</button></div>`;
    output.querySelector('.filename-copy-locator').onclick = async (event) => {
      await navigator.clipboard.writeText(locator);
      event.currentTarget.textContent = 'Copied';
    };
  } catch (error) {
    output.innerHTML = `<div class="notice ${error?.name === 'AbortError' ? 'warn' : 'error'}">${error?.name === 'AbortError' ? 'Mapping cancelled.' : escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(buffer) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
}

async function contentLocator(file, token, onProgress) {
  const chunkHashes = [];
  const totalChunks = Math.ceil(file.size / HASH_CHUNK_BYTES);
  for (let i = 0; i < totalChunks; i++) {
    if (token.cancelled) throw new DOMException('Cancelled', 'AbortError');
    const start = i * HASH_CHUNK_BYTES;
    const end = Math.min(file.size, start + HASH_CHUNK_BYTES);
    const chunk = await file.slice(start, end).arrayBuffer();
    chunkHashes.push(await sha256(chunk));
    onProgress?.(i + 1, totalChunks, end);
    if ((i + 1) % 4 === 0) await new Promise(requestAnimationFrame);
  }
  const manifest = new Uint8Array(chunkHashes.length * 32);
  chunkHashes.forEach((digest, i) => manifest.set(digest, i * 32));
  const root = await sha256(manifest);
  return `ICFILE1:${file.size}:${HASH_CHUNK_BYTES}:${hex(root)}`;
}

async function runFilenameSearch() {
  const button = $('#regex-generate');
  try {
    const re = compileRegex($('#regex-input').value, $('#filename-case-insensitive').checked);
    const scope = $('#filename-scope').value;
    const limit = Math.min(MAX_RESULTS, Math.max(1, Number($('#regex-count').value) || 100));
    const results = [];
    let totalMatches = 0;

    button.disabled = true;
    $('#regex-results').innerHTML = '<div class="notice">Searching indexed filenames…</div>';

    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      const haystack = scope === 'path' ? (item.path || item.name) : item.name;
      re.lastIndex = 0;
      if (re.test(haystack)) {
        totalMatches++;
        if (results.length < limit) results.push(item);
      }
      if ((i + 1) % 50000 === 0) await new Promise(requestAnimationFrame);
    }

    if (!totalMatches) {
      renderEmpty(`No indexed filenames matched. ${entries.length ? 'Try a broader regex or load another folder/catalog.' : 'Load a local folder or import a catalog first.'}`);
      return;
    }
    renderResults(results, totalMatches, entries.length);
  } catch (error) {
    $('#regex-results').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function installUi() {
  const panel = $('#panel-regex');
  const tab = document.querySelector('[data-tab="regex"]');
  if (!panel || !tab) return;

  tab.textContent = 'Filename Regex';
  panel.innerHTML = `
    <div class="card">
      <span class="eyebrow">Real filename index</span>
      <h3>Regex filename search</h3>
      <p class="help">Search real filenames from a folder you select or a catalog you import. This replaces synthetic regex generation. The browser does not invent matches: a result exists only if its filename is actually present in the loaded index. Local files can be mapped from their real bytes.</p>
      <div class="grid-2">
        <div><label for="regex-input">Filename regex</label><input id="regex-input" class="mono" type="text" value="EFTA[0-9]{8}\\.pdf"></div>
        <div><label for="regex-count">Maximum results</label><input id="regex-count" type="number" min="1" max="${MAX_RESULTS}" value="100"></div>
        <div><label for="filename-scope">Match against</label><select id="filename-scope" class="input"><option value="name" selected>Filename only</option><option value="path">Relative/full catalog path</option></select></div>
        <div><label>Options</label><label class="xl-check"><input id="filename-case-insensitive" type="checkbox"><span>Case-insensitive</span></label></div>
      </div>
      <div class="button-row"><button id="regex-generate">Search indexed filenames</button><button id="filename-clear" class="secondary">Clear index</button></div>
      <div id="filename-index-status" class="muted" style="margin-top:12px">0 indexed names</div>
    </div>

    <div class="grid-2">
      <div class="card">
        <span class="eyebrow">Local filesystem</span><h3>Index a folder</h3>
        <p class="help">Choose a directory. Only names, paths, sizes, and browser File references stay in this tab. Nothing is uploaded.</p>
        <input id="filename-folder-input" class="input" type="file" webkitdirectory directory multiple>
      </div>
      <div class="card">
        <span class="eyebrow">Portable catalog</span><h3>Import a filename catalog</h3>
        <p class="help">Accepts JSON, CSV, or newline-delimited TXT. JSON entries may contain <code>name</code>, <code>path</code>, <code>url</code>, and <code>size</code>. Catalog entries can be searched even when the file bytes are not local.</p>
        <input id="filename-catalog-input" class="input" type="file" accept=".json,.csv,.txt,application/json,text/csv,text/plain">
        <div style="margin-top:12px"><label for="filename-catalog-url">Or load a CORS-enabled catalog URL</label><div class="path-wrap"><input id="filename-catalog-url" type="text" placeholder="https://example.com/files.json"><button id="filename-load-url" class="secondary">Load URL</button></div></div>
      </div>
    </div>
    <div id="regex-results"><div class="notice">Load a local folder or filename catalog, then run a regex search.</div></div>`;

  $('#filename-folder-input').onchange = (event) => {
    const files = [...(event.target.files || [])];
    const local = files.map(file => ({
      kind: 'local',
      name: file.name,
      path: file.webkitRelativePath || file.name,
      url: '',
      size: file.size,
      source: 'Local folder',
      file,
    }));
    entries = dedupe([...entries, ...local]);
    updateIndexStatus(`added ${local.length.toLocaleString()} local files`);
  };

  $('#filename-catalog-input').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = parseCatalogText(await file.text(), file.name, file.name);
      entries = dedupe([...entries, ...imported]);
      updateIndexStatus(`added ${imported.length.toLocaleString()} catalog entries`);
    } catch (error) {
      updateIndexStatus(`catalog error: ${error.message}`);
    }
  };

  $('#filename-load-url').onclick = async () => {
    const url = $('#filename-catalog-url').value.trim();
    if (!url) return;
    const button = $('#filename-load-url');
    button.disabled = true;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const imported = parseCatalogText(text, new URL(url).pathname, url);
      entries = dedupe([...entries, ...imported]);
      updateIndexStatus(`added ${imported.length.toLocaleString()} entries from URL`);
    } catch (error) {
      updateIndexStatus(`URL catalog error: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  };

  $('#filename-clear').onclick = () => {
    entries = [];
    currentResults = [];
    $('#filename-folder-input').value = '';
    $('#filename-catalog-input').value = '';
    updateIndexStatus('cleared');
    renderEmpty('Index cleared. Load a folder or catalog to search real filenames.');
  };

  $('#regex-generate').onclick = runFilenameSearch;
  $('#regex-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') runFilenameSearch();
  });
  updateIndexStatus();
}

installUi();
