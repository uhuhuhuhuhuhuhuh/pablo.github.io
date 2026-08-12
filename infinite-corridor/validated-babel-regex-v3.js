import { formatBytes } from './codec.js';

const $ = s => document.querySelector(s);
const HARD_MAX_BYTES = 1024 ** 4;
const HARD_REPEAT_CAP = 4096;
const HARD_BUDGET = 10_000_000;
const MAX_RESULTS = 500;
const MAX_MATERIAL_BYTES = 1024 * 1024;
let currentResults = [];
let searchWorker = null;
let pathWorker = null;
let pathJobId = 0;
const pathJobs = new Map();
let latestStats = { attempts: 0, accepted: 0, rejected: 0 };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
}
function validationBadge(v) {
  if (v.strict) return 'STRICT PASS';
  if (v.valid) return 'READABLE';
  if (v.recognizable) return 'SIGNATURE ONLY';
  return 'GARBLED / UNKNOWN';
}
function contentBadge(v) {
  if (v.contentRich) return 'RICH CONTENT';
  if (v.contentNontrivial) return 'NON-TRIVIAL CONTENT';
  if (v.contentScore > 0) return 'LOW CONTENT';
  return 'EMPTY / UNKNOWN CONTENT';
}
function updateSummary(extra = '') {
  const el = $('#regex-search-summary');
  if (!el) return;
  el.innerHTML = `<strong>${latestStats.accepted.toLocaleString()} accepted candidates</strong><br><span class="muted">${latestStats.attempts.toLocaleString()} attempts · ${latestStats.rejected.toLocaleString()} rejected${extra ? ` · ${escapeHtml(extra)}` : ''}. Heavy generation and validation run in a Web Worker.</span>`;
}
function makeResultHtml(r, idx) {
  const format = r.validation.format === 'binary' ? 'unknown format' : r.validation.format.toUpperCase();
  const address = r.kind === 'virtual' ? r.recipe : 'Babel address not calculated yet';
  const shown = address.length > 520 ? `${address.slice(0,250)}…${address.slice(-250)}` : address;
  return `<article class="regex-result" data-babel-result="${idx}">
    <div>
      <span class="eyebrow">${r.kind === 'materialized' ? 'Inspected materialized candidate' : 'Virtual Babel candidate'}</span>
      <strong>${escapeHtml(r.filename)}</strong>
      <div class="regex-meta">
        <span>${formatBytes(r.size)}</span>
        <span class="babel-depth">${r.depth.toLocaleString()} estimated levels</span>
        <span>${escapeHtml(format)}</span>
        <span>${escapeHtml(validationBadge(r.validation))} · validation ${r.validation.score}</span>
        <span>${escapeHtml(contentBadge(r.validation))} · content ${r.validation.contentScore}</span>
      </div>
      <div class="muted" style="margin-top:6px">${escapeHtml(r.validation.details)}</div>
      <div class="muted" style="margin-top:4px"><strong>Content inspection:</strong> ${escapeHtml(r.validation.contentDetails)}</div>
    </div>
    <code title="${escapeHtml(r.kind === 'virtual' ? r.recipe : '')}">${escapeHtml(shown)}</code>
    <div class="button-row" style="margin-top:0">
      ${r.kind === 'materialized'
        ? `<button class="secondary babel-calc" data-i="${idx}">Calculate Babel address</button><button class="secondary babel-download" data-i="${idx}">Download candidate</button>`
        : `<button class="secondary babel-copy" data-i="${idx}">Copy recipe</button>`}
    </div>
    <div class="babel-address-output" style="grid-column:1/-1"></div>
  </article>`;
}
function appendBatch(items) {
  const list = $('#regex-result-list');
  if (!list) return;
  let html = '';
  for (const item of items) {
    if (item.buffer) { item.bytes = new Uint8Array(item.buffer); delete item.buffer; }
    const idx = currentResults.length;
    currentResults.push(item);
    html += makeResultHtml(item, idx);
  }
  list.insertAdjacentHTML('beforeend', html);
}
function ensurePathWorker() {
  if (pathWorker) return pathWorker;
  pathWorker = new Worker(new URL('./babel-path-worker.js?v=20260812m', import.meta.url), { type:'module' });
  pathWorker.onmessage = event => {
    const msg = event.data || {}, job = pathJobs.get(msg.id);
    if (!job) return;
    pathJobs.delete(msg.id);
    const r = currentResults[job.index], article = document.querySelector(`[data-babel-result="${job.index}"]`), button = article?.querySelector('.babel-calc'), output = article?.querySelector('.babel-address-output');
    if (!r || !article) return;
    if (!msg.ok) {
      if (button) { button.disabled = false; button.textContent = 'Retry Babel address'; }
      if (output) output.innerHTML = `<div class="notice error">${escapeHtml(msg.error || 'Babel path calculation failed')}</div>`;
      return;
    }
    r.path = msg.path; r.depth = msg.depth;
    const code = article.querySelector('code');
    if (code) { const shown = msg.path.length > 520 ? `${msg.path.slice(0,250)}…${msg.path.slice(-250)}` : msg.path; code.title = msg.path; code.textContent = shown; }
    const depth = article.querySelector('.babel-depth'); if (depth) depth.textContent = `${msg.depth.toLocaleString()} exact levels`;
    if (button) { button.disabled = false; button.textContent = 'Copy Babel address'; button.dataset.ready = '1'; }
    if (output) output.innerHTML = `<div class="muted">Exact path calculated in ${Number(msg.ms || 0).toFixed(0)} ms in a background worker.</div>`;
  };
  return pathWorker;
}
function calculatePath(index, button) {
  const r = currentResults[index];
  if (!r?.bytes) return;
  if (r.path) {
    navigator.clipboard.writeText(r.path);
    const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => button.textContent = old, 900); return;
  }
  button.disabled = true; button.textContent = 'Calculating in worker…';
  const id = ++pathJobId, copy = r.bytes.slice(); pathJobs.set(id, { index });
  ensurePathWorker().postMessage({ id, buffer: copy.buffer }, [copy.buffer]);
}
function downloadCandidate(r) {
  if (!r?.bytes) return;
  const blob = new Blob([r.bytes], { type:'application/octet-stream' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = r.filename || 'corridor-candidate.bin'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stopSearch(message = 'Search cancelled.') {
  if (searchWorker) { searchWorker.terminate(); searchWorker = null; }
  const button = $('#regex-generate'), cancel = $('#regex-cancel'), status = $('#babel-regex-status');
  if (button) button.disabled = false; if (cancel) cancel.disabled = true; if (status) status.textContent = message;
}
function startSearch() {
  stopSearch('Preparing new search…');
  currentResults = []; latestStats = { attempts:0,accepted:0,rejected:0 };
  const results = $('#regex-results');
  results.innerHTML = `<div id="regex-search-summary" class="notice"><strong>0 accepted candidates</strong><br><span class="muted">Starting background search…</span></div><div id="regex-result-list"></div>`;
  const button = $('#regex-generate'), cancel = $('#regex-cancel'), status = $('#babel-regex-status');
  button.disabled = true; cancel.disabled = false; status.textContent = 'Starting search worker…';
  const settings = {
    raw: $('#regex-input').value,
    count: Number($('#regex-count').value), budget: Number($('#regex-budget').value),
    minBytes: Number($('#regex-min-bytes').value), maxBytes: Number($('#regex-max-bytes').value), mode: $('#regex-depth-mode').value,
    repeatCap: Number($('#regex-repeat-cap').value), numericStart: Number($('#regex-numeric-start').value), strategy: $('#regex-payload-strategy').value,
    validationLevel: $('#regex-validation-level').value, minValidationScore: Number($('#regex-min-score').value),
    contentRequirement: $('#regex-content-level').value, minContentScore: Number($('#regex-content-score').value)
  };
  const worker = new Worker(new URL('./babel-regex-search-worker-v3.js?v=20260812m', import.meta.url), { type:'module' });
  searchWorker = worker;
  worker.onmessage = event => {
    if (worker !== searchWorker) return;
    const msg = event.data || {};
    if (msg.type === 'meta') {
      status.textContent = msg.note || `Materialized validation can inspect candidates up to ${formatBytes(MAX_MATERIAL_BYTES)} each.`;
      updateSummary(msg.note || 'inspection worker active');
    } else if (msg.type === 'batch') {
      latestStats = { attempts:msg.attempts||latestStats.attempts, accepted:msg.accepted||latestStats.accepted, rejected:msg.rejected||latestStats.rejected };
      appendBatch(msg.items || []); updateSummary();
    } else if (msg.type === 'progress') {
      latestStats = { attempts:msg.attempts||0,accepted:msg.accepted||0,rejected:msg.rejected||0 };
      status.textContent = `${latestStats.attempts.toLocaleString()} attempts · ${latestStats.accepted.toLocaleString()} accepted · ${latestStats.rejected.toLocaleString()} rejected`;
      updateSummary();
    } else if (msg.type === 'done') {
      latestStats = { attempts:msg.attempts||0,accepted:msg.accepted||0,rejected:msg.rejected||0 };
      updateSummary(msg.note || 'complete');
      status.textContent = `Finished: ${latestStats.accepted.toLocaleString()} accepted from ${latestStats.attempts.toLocaleString()} attempts.`;
      searchWorker = null; worker.terminate(); button.disabled = false; cancel.disabled = true;
      if (!latestStats.accepted) $('#regex-result-list').innerHTML = '<div class="notice warn">No candidates passed both file-format validation and the selected content-quality requirement.</div>';
    } else if (msg.type === 'error') {
      $('#regex-result-list').innerHTML = `<div class="notice error">${escapeHtml(msg.message || 'Search worker failed')}</div>`;
      stopSearch('Search stopped because the constraints could not be satisfied.');
    }
  };
  worker.onerror = event => {
    $('#regex-result-list').innerHTML = `<div class="notice error">${escapeHtml(event.message || 'Search worker crashed')}</div>`;
    stopSearch('Search worker stopped.');
  };
  worker.postMessage({ type:'start', settings });
}
function installUi() {
  const panel = $('#panel-regex'), tab = document.querySelector('[data-tab="regex"]');
  if (!panel || !tab) return;
  tab.textContent = 'Babel Regex';
  panel.innerHTML = `<div class="card">
    <span class="eyebrow">Filename → candidate bytes → format validation → content inspection → Babel address</span>
    <h3>Babel regex candidate search</h3>
    <p class="help">Generate candidate filenames and byte sizes, then inspect actual materialized candidate bytes in a background worker. File-format validity and content quality are separate filters, so a technically valid but blank PDF or trivial image can be rejected.</p>
    <div class="grid-2"><div><label for="regex-input">Filename regex</label><input id="regex-input" class="mono" type="text" value="EFTA[0-9]{8}\\.pdf"></div><div><label for="regex-count">Results</label><input id="regex-count" type="number" min="1" max="${MAX_RESULTS}" value="100"></div></div>
    <div class="grid-3" style="margin-top:16px">
      <div><label for="regex-min-bytes">Minimum bytes</label><input id="regex-min-bytes" type="number" min="0" max="${HARD_MAX_BYTES}" value="10000"></div>
      <div><label for="regex-max-bytes">Maximum bytes (up to 1 TiB)</label><input id="regex-max-bytes" type="number" min="1" max="${HARD_MAX_BYTES}" value="80000"></div>
      <div><label for="regex-depth-mode">Size/depth bias</label><select id="regex-depth-mode" class="input"><option value="deep" selected>Bias larger/deeper</option><option value="max">Always maximum bytes</option><option value="balanced">Balanced/random</option></select></div>
      <div><label for="regex-budget">Candidate attempts (up to 10,000,000)</label><input id="regex-budget" type="number" min="1" max="${HARD_BUDGET}" value="5000"></div>
      <div><label for="regex-repeat-cap">Open-ended regex repeat cap</label><input id="regex-repeat-cap" type="number" min="1" max="${HARD_REPEAT_CAP}" value="256"></div>
      <div><label for="regex-numeric-start">Numeric start / offset</label><input id="regex-numeric-start" type="number" min="0" value="0"></div>
    </div>
    <div class="grid-3" style="margin-top:16px">
      <div><label for="regex-payload-strategy">Payload strategy</label><select id="regex-payload-strategy" class="input"><option value="format" selected>Format-aware generation</option><option value="random">Deterministic random bytes</option></select></div>
      <div><label for="regex-validation-level">Validation requirement</label><select id="regex-validation-level" class="input"><option value="any">Any bytes</option><option value="signature">Recognizable signature</option><option value="readable">Structurally valid / readable</option><option value="strict" selected>Strict materialized validation</option></select></div>
      <div><label for="regex-min-score">Minimum validation score (0–100)</label><input id="regex-min-score" type="number" min="0" max="100" value="80"></div>
      <div><label for="regex-content-level">Content requirement</label><select id="regex-content-level" class="input"><option value="any">Any content, including trivial</option><option value="nontrivial" selected>Non-trivial / visibly populated</option><option value="rich">Rich content only</option></select></div>
      <div><label for="regex-content-score">Minimum content score (0–100)</label><input id="regex-content-score" type="number" min="0" max="100" value="60"></div>
      <div><label>Inspection ceiling</label><div class="notice" style="margin:0;padding:11px 13px">${formatBytes(MAX_MATERIAL_BYTES)} per candidate · 32 MiB accepted-result memory budget</div></div>
    </div>
    <div class="notice" style="margin-top:16px"><strong>Content-aware formats:</strong> PDFs are checked for visible text/drawing content and page count; PNGs for dimensions and sampled color variation; ZIPs for non-empty stored payload; JSON for populated structure; text for actual word content; Safetensors for real tensor data. Metadata-only GGUF candidates fail the non-trivial-content filter.</div>
    <div class="notice" style="margin-top:12px"><strong>Performance:</strong> candidate generation, format parsing, CRC checks, and content inspection now run off the main browser thread. Exact Babel path calculation is still separate and only runs when you click a result.</div>
    <div class="notice" style="margin-top:12px"><strong>Numeric patterns:</strong> <code>EFTA[0-9]{8}\\.pdf</code> is enumerated sequentially. Set Numeric start to <code>2822476</code> to begin at <code>EFTA02822476.pdf</code>.</div>
    <div class="button-row"><button id="regex-generate">Search inspected Babel candidates</button><button id="regex-cancel" class="secondary" disabled>Cancel search</button></div>
    <div id="babel-regex-status" class="muted" style="margin-top:12px">Ready.</div>
  </div><div id="regex-results"><div class="notice">Choose filename, size, validation, and content conditions, then search.</div></div>`;
  $('#regex-generate').onclick = startSearch;
  $('#regex-cancel').onclick = () => stopSearch();
  $('#regex-input').addEventListener('keydown', event => { if (event.key === 'Enter') startSearch(); });
  $('#regex-results').addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    const index = Number(button.dataset.i), r = currentResults[index];
    if (button.classList.contains('babel-calc')) calculatePath(index, button);
    else if (button.classList.contains('babel-download')) downloadCandidate(r);
    else if (button.classList.contains('babel-copy') && r?.recipe) { await navigator.clipboard.writeText(r.recipe); const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,900); }
  });
}
installUi();
