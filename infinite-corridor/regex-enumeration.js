import { bytesToPath, normalizePath, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const encoder = new TextEncoder();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function regexSource(raw) {
  raw = String(raw ?? '').trim();
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) return raw.slice(1, raw.lastIndexOf('/'));
  return raw;
}

function literalPart(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      if (i + 1 >= source.length) return null;
      const next = source[++i];
      if ('dwsnrt123456789'.includes(next)) return null;
      out += next;
      continue;
    }
    if ('[]()|*+?{}.^$'.includes(c)) return null;
    out += c;
  }
  return out;
}

function parseFixedNumericPattern(raw) {
  const source = regexSource(raw);
  const match = source.match(/^(.*)\[0-9\]\{(\d{1,2})\}(.*)$/);
  if (!match) return null;
  const width = Number(match[2]);
  if (!Number.isInteger(width) || width < 1 || width > 18) return null;
  const prefix = literalPart(match[1]);
  const suffix = literalPart(match[3]);
  if (prefix === null || suffix === null) return null;
  return { source, prefix, suffix, width, max: (10n ** BigInt(width)) - 1n };
}

function addControls() {
  const deep = $('#regex-deep-controls');
  const panel = $('#panel-regex');
  if (!panel || $('#regex-numeric-enumeration')) return;

  const box = document.createElement('div');
  box.id = 'regex-numeric-enumeration';
  box.className = 'notice';
  box.style.marginTop = '14px';
  box.innerHTML = `
    <strong>Fixed-width numeric enumeration</strong><br>
    <span class="muted">Patterns such as <code>EFTA[0-9]{8}\\.pdf</code> can be enumerated deterministically instead of randomly sampled. This enumerates matching text/designations only. It cannot reconstruct an unrelated PDF's contents from its filename.</span>
    <div class="grid-3" style="margin-top:12px">
      <div><label for="regex-numeric-mode">Numeric handling</label><select id="regex-numeric-mode" class="input"><option value="auto" selected>Auto-detect and enumerate</option><option value="random">Use random/deep generator</option></select></div>
      <div><label for="regex-numeric-start">Numeric start</label><input id="regex-numeric-start" type="text" value="0" inputmode="numeric"></div>
      <div><label>Detected pattern</label><div id="regex-numeric-detected" class="pill" style="display:inline-block">None</div></div>
    </div>`;

  if (deep) deep.appendChild(box);
  else panel.querySelector('.card')?.appendChild(box);

  const refresh = () => {
    const spec = parseFixedNumericPattern($('#regex-input')?.value);
    const target = $('#regex-numeric-detected');
    if (!target) return;
    target.textContent = spec ? `${spec.width}-digit numeric field` : 'None';
  };
  $('#regex-input')?.addEventListener('input', refresh);
  refresh();
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runNumericEnumeration(spec) {
  const target = $('#regex-results');
  const status = $('#regex-deep-status');
  const count = Math.min(250, Math.max(1, Number($('#regex-count')?.value) || 10));
  const rawStart = String($('#regex-numeric-start')?.value ?? '0').trim();
  if (!/^\d+$/.test(rawStart)) throw new Error('Numeric start must contain digits only.');
  let start = BigInt(rawStart);
  if (start < 0n || start > spec.max) throw new Error(`Numeric start must be between 0 and ${spec.max.toString()}.`);

  const results = [];
  for (let i = 0; i < count && start + BigInt(i) <= spec.max; i++) {
    const value = start + BigInt(i);
    const digits = value.toString().padStart(spec.width, '0');
    const text = `${spec.prefix}${digits}${spec.suffix}`;
    const bytes = encoder.encode(text);
    const path = bytesToPath(bytes);
    results.push({ text, bytes, path, depth: normalizePath(path).length });
  }

  target.innerHTML = results.map((result, idx) => {
    const shown = result.path.length > 520 ? `${result.path.slice(0, 250)}…${result.path.slice(-250)}` : result.path;
    return `<article class="regex-result" data-enumerated-result="${idx}">
      <div><span class="eyebrow">Enumerated designation ${idx + 1}</span><strong>${escapeHtml(result.text)}</strong><div class="regex-meta"><span>${formatBytes(result.bytes.length)} generated text</span><span>${result.depth.toLocaleString()} levels</span></div></div>
      <code title="This is the Corridor address of the generated designation text, not the contents of a same-named external file.">${escapeHtml(shown)}</code>
      <div class="button-row" style="margin-top:0"><button class="secondary enum-copy" data-i="${idx}">Copy</button><button class="secondary enum-download" data-i="${idx}">Download text</button></div>
    </article>`;
  }).join('');

  target.querySelectorAll('.enum-copy').forEach(btn => btn.addEventListener('click', async () => {
    const result = results[Number(btn.dataset.i)];
    await navigator.clipboard.writeText(result.path);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 900);
  }));

  target.querySelectorAll('.enum-download').forEach(btn => btn.addEventListener('click', () => {
    const result = results[Number(btn.dataset.i)];
    downloadBytes(result.bytes, result.text || `regex-${btn.dataset.i}.txt`);
  }));

  if (status) {
    const first = results[0]?.text || 'none';
    const last = results.at(-1)?.text || 'none';
    status.textContent = `Deterministic numeric enumeration · ${results.length.toLocaleString()} shown · ${first} → ${last}. These are designation strings, not external file contents.`;
  }
}

function install() {
  addControls();
  const button = $('#regex-generate');
  if (!button || button.dataset.numericWrapped === '1') return;
  const fallback = button.onclick;
  button.onclick = async (event) => {
    const mode = $('#regex-numeric-mode')?.value || 'auto';
    const spec = parseFixedNumericPattern($('#regex-input')?.value);
    if (mode === 'auto' && spec) {
      try {
        button.disabled = true;
        await runNumericEnumeration(spec);
      } catch (error) {
        $('#regex-results').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (typeof fallback === 'function') return fallback.call(button, event);
  };
  button.dataset.numericWrapped = '1';
}

install();
