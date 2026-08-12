import { createIcsToken, formatIcsBytes } from './ics-share-codec.js?v=20260812ics1';
import { pathToBytes } from './codec.js?v=20260812ics1';

const $ = s => document.querySelector(s);
const MAX_TOKEN_CHARS = 1_500_000;
const MAX_LITERAL_PATH_CHARS = 2_000_000;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
  }[c]));
}

function cleanFilename(value) {
  const name = String(value || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  if (!name) throw new Error('A filename is required.');
  return name.slice(0, 255);
}

function buildShareUrl(token, filename) {
  if (token.length > MAX_TOKEN_CHARS) {
    throw new Error(`This self-contained token is ${token.length.toLocaleString()} characters, above the ${MAX_TOKEN_CHARS.toLocaleString()} character browser-safety limit. The file does not compress enough for a practical self-contained URL.`);
  }
  const url = new URL('./s/', location.href);
  url.hash = `${token}/${encodeURIComponent(cleanFilename(filename))}`;
  return url.toString();
}

function renderResult(target, result, filename) {
  const compression = result.mode === 'G'
    ? `gzip compressed ${formatIcsBytes(result.originalBytes)} → ${formatIcsBytes(result.packedBytes)}`
    : `raw reversible payload ${formatIcsBytes(result.originalBytes)}`;

  target.innerHTML = `<div class="notice">
    <strong>Self-contained share ready</strong><br>
    <a class="mono" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.url.length > 260 ? result.url.slice(0, 220) + '…/' + filename : result.url)}</a>
    <div class="muted" style="margin-top:8px">${escapeHtml(compression)} · ${result.url.length.toLocaleString()} URL characters · random salt ${escapeHtml(result.salt.slice(0, 10))}… is discarded by the receiver.</div>
    <div class="button-row"><button class="secondary share-copy">Copy share link</button><button class="secondary share-open">Open share</button></div>
  </div>`;

  target.querySelector('.share-copy').onclick = async event => {
    await navigator.clipboard.writeText(result.url);
    const button = event.currentTarget, old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => button.textContent = old, 900);
  };
  target.querySelector('.share-open').onclick = () => window.open(result.url, '_blank', 'noopener,noreferrer');
}

async function encodeBytes(bytes, filename, status, target) {
  status.textContent = `Encoding ${formatIcsBytes(bytes.length)} locally…`;
  const encoded = await createIcsToken(bytes);
  const url = buildShareUrl(encoded.token, filename);
  renderResult(target, { ...encoded, url }, filename);
  status.textContent = 'Ready. No file bytes or manifest were uploaded anywhere.';
}

async function shareLocalFile() {
  const file = $('#share-local-file').files?.[0];
  const status = $('#share-local-status');
  const result = $('#share-local-result');
  result.innerHTML = '';
  if (!file) throw new Error('Choose a local file first.');

  status.textContent = `Reading ${file.name} locally…`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await encodeBytes(bytes, file.name, status, result);
}

async function shareLiteralPath() {
  const path = $('#share-path').value.trim();
  const filename = cleanFilename($('#share-path-name').value);
  const status = $('#share-path-status');
  const result = $('#share-path-result');
  result.innerHTML = '';

  if (!path) throw new Error('Paste a literal Babel /.../file path first.');
  if (!path.startsWith('/') || !path.endsWith('/file')) throw new Error('This input is not a literal Babel /.../file path.');
  if (path.length > MAX_LITERAL_PATH_CHARS) throw new Error('That literal Babel path is too large to expand safely in this browser tab.');

  status.textContent = 'Reconstructing the exact bytes represented by the Babel path…';
  await new Promise(requestAnimationFrame);
  const bytes = pathToBytes(path);
  await encodeBytes(bytes, filename, status, result);
}

function installUi() {
  const panel = $('#panel-share');
  if (!panel) return;

  panel.innerHTML = `<div class="card">
    <span class="eyebrow">No registry · no server · no upload</span>
    <h3>Self-Contained Corridor Share</h3>
    <p class="help">A share URL carries the reversible file information inside its fragment. The browser optionally gzip-compresses the bytes, adds an integrity hash, and adds a fresh random salt so repeated shares of the same file produce different-looking URLs. The receiver throws the salt away, verifies the hash, reconstructs the original bytes locally, and downloads using the filename at the end of the URL.</p>
    <div class="notice"><strong>Format:</strong> <code>/s/#ICS1.&lt;throwaway-salt&gt;.&lt;mode&gt;.&lt;sha256&gt;.&lt;payload&gt;/filename.ext</code><br>The fragment after <code>#</code> is not sent to GitHub Pages. There is no short-ID collision database because the token itself contains the reversible information.</div>
  </div>

  <div class="grid-2">
    <div class="card">
      <span class="eyebrow">Local file → ICS1 URL</span>
      <h3>Share a local file</h3>
      <p class="help">The file is read and encoded entirely in this browser. Create the link again and you will get a different random salt but the receiver will reconstruct the same bytes.</p>
      <input id="share-local-file" class="input" type="file">
      <div class="button-row"><button id="share-local-create">Create self-contained link</button></div>
      <div id="share-local-status" class="muted" style="margin-top:10px">Ready.</div>
      <div id="share-local-result" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <span class="eyebrow">Existing Babel path → compact share</span>
      <h3>Share a literal Babel object</h3>
      <label for="share-path-name">Download filename</label>
      <input id="share-path-name" type="text" placeholder="readme.txt">
      <label for="share-path">Literal Babel path</label>
      <textarea id="share-path" class="mono" placeholder="/AA/.../file"></textarea>
      <div class="button-row"><button id="share-path-create">Create self-contained link</button></div>
      <div id="share-path-status" class="muted" style="margin-top:10px">Ready.</div>
      <div id="share-path-result" style="margin-top:12px"></div>
    </div>
  </div>

  <div class="card help">
    <h3>What the salt does</h3>
    <p>The salt is deliberately not part of the file reconstruction. It is random URL noise only. Two shares of identical bytes therefore normally have different URLs, while removing the salt during decode yields the same original file. It is not encryption and does not make a public share private.</p>
    <p>Self-contained sharing cannot turn an arbitrary multi-gigabyte incompressible file into a tiny URL. The current browser-safety cap is ${MAX_TOKEN_CHARS.toLocaleString()} token characters. Compressible text and structured data can fit much more efficiently than already-compressed video, ZIP, PNG, JPEG, and similar formats.</p>
  </div>`;

  $('#share-local-create').onclick = () => shareLocalFile().catch(error => {
    $('#share-local-status').textContent = error.message;
    $('#share-local-result').innerHTML = '';
  });

  $('#share-path-create').onclick = () => shareLiteralPath().catch(error => {
    $('#share-path-status').textContent = error.message;
    $('#share-path-result').innerHTML = '';
  });
}

installUi();
