const $ = (s) => document.querySelector(s);

const MAX_BYTES = 1n << 40n; // 1 TiB
const CHUNK_SIZE = 4 * 1024 * 1024;
let cancelRequested = false;

const multipliers = {
  B: 1n,
  KiB: 1n << 10n,
  MiB: 1n << 20n,
  GiB: 1n << 30n,
  TiB: 1n << 40n,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function parseSize() {
  const raw = $('#xl-size').value.trim();
  const unit = $('#xl-unit').value;
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('Enter a positive size with up to 6 decimal places.');
  const [whole, frac = ''] = raw.split('.');
  const scale = 10n ** BigInt(frac.length);
  const scaled = BigInt(whole + frac);
  const bytes = (scaled * multipliers[unit]) / scale;
  if (bytes < 1n) throw new Error('File size must be at least 1 byte.');
  if (bytes > MAX_BYTES) throw new Error('This build caps XL objects at 1 TiB.');
  return bytes;
}

function formatBigBytes(n) {
  const units = [['TiB', 1n<<40n], ['GiB', 1n<<30n], ['MiB', 1n<<20n], ['KiB', 1n<<10n]];
  for (const [name, size] of units) {
    if (n >= size) {
      const whole = n / size;
      const rem = Number((n % size) * 100n / size);
      return `${whole}.${String(rem).padStart(2,'0')} ${name}`;
    }
  }
  return `${n} B`;
}

function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function base64urlDecode(value) {
  const b64 = value.replaceAll('-','+').replaceAll('_','/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function currentAddress(size = parseSize()) {
  const mode = $('#xl-mode').value;
  let payload = '-';
  if (mode === 'text') {
    const text = $('#xl-pattern').value;
    if (!text.length) throw new Error('Enter a repeating text pattern.');
    if (new TextEncoder().encode(text).length > 65536) throw new Error('Repeating text pattern is capped at 64 KiB.');
    payload = base64urlEncode(text);
  } else if (mode === 'seeded') {
    const seed = $('#xl-seed').value || 'infinite-corridor';
    payload = base64urlEncode(seed);
  }
  return `ICXL1:${size}:${mode}:${payload}`;
}

function fnv1a(text) {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 0x9e3779b9;
}

function makeTemplate(mode) {
  if (mode === 'zero') return new Uint8Array(CHUNK_SIZE);
  if (mode === 'counter') {
    const out = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
    return out;
  }
  if (mode === 'text') {
    const pattern = new TextEncoder().encode($('#xl-pattern').value);
    if (!pattern.length) throw new Error('Enter a repeating text pattern.');
    const out = new Uint8Array(CHUNK_SIZE);
    for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length];
    return out;
  }
  if (mode === 'seeded') {
    const out = new Uint8Array(CHUNK_SIZE);
    let x = fnv1a($('#xl-seed').value || 'infinite-corridor');
    for (let i = 0; i < out.length; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17; x >>>= 0;
      x ^= x << 5; x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  }
  throw new Error('Unknown XL generation mode.');
}

function updateModeUi() {
  const mode = $('#xl-mode').value;
  $('#xl-text-options').hidden = mode !== 'text';
  $('#xl-seed-options').hidden = mode !== 'seeded';
  updateSummary();
}

function updateSummary() {
  const target = $('#xl-summary');
  try {
    const size = parseSize();
    const equivalentLevels = Math.ceil(Number(size > 10_000_000_000_000n ? 10_000_000_000_000n : size) * 0.6526048787340432);
    const depthText = size <= 10_000_000_000_000n ? equivalentLevels.toLocaleString() : '>6.5 trillion';
    const address = currentAddress(size);
    target.innerHTML = `<strong>${formatBigBytes(size)}</strong> virtual object<br><span class="muted">Approximate literal Babel depth for an arbitrary object of this size: ${depthText} levels. XL stores the generation recipe compactly instead.</span><div class="xl-address mono">${escapeHtml(address)}</div>`;
  } catch (e) {
    target.innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

function parseAddress(address) {
  const parts = address.trim().split(':');
  if (parts.length !== 4 || parts[0] !== 'ICXL1') throw new Error('Not a valid ICXL1 address.');
  const size = BigInt(parts[1]);
  if (size < 1n || size > MAX_BYTES) throw new Error('XL address size is outside the supported 1 B–1 TiB range.');
  const mode = parts[2];
  if (!['zero','counter','text','seeded'].includes(mode)) throw new Error('Unknown XL mode in address.');
  const unitChoices = [['TiB',1n<<40n],['GiB',1n<<30n],['MiB',1n<<20n],['KiB',1n<<10n],['B',1n]];
  const exact = unitChoices.find(([,m]) => size % m === 0n) || ['B',1n];
  $('#xl-size').value = String(size / exact[1]);
  $('#xl-unit').value = exact[0];
  $('#xl-mode').value = mode;
  if (mode === 'text') $('#xl-pattern').value = base64urlDecode(parts[3]);
  if (mode === 'seeded') $('#xl-seed').value = base64urlDecode(parts[3]);
  updateModeUi();
}

async function copyAddress() {
  const address = currentAddress();
  await navigator.clipboard.writeText(address);
  $('#xl-status').textContent = 'XL address copied.';
}

async function saveFile() {
  if (!window.showSaveFilePicker) {
    throw new Error('Large streamed saving needs the File System Access API. Use a Chromium-based desktop browser such as Chrome, Edge, or a compatible Opera build.');
  }
  const total = parseSize();
  const mode = $('#xl-mode').value;
  const suggestedName = ($('#xl-filename').value.trim() || 'corridor-xl.bin').replace(/[\\/:*?"<>|]/g, '_');
  const handle = await window.showSaveFilePicker({ suggestedName });
  const writable = await handle.createWritable();
  cancelRequested = false;
  $('#xl-cancel').disabled = false;
  $('#xl-save').disabled = true;
  $('#xl-progress').value = 0;
  $('#xl-status').textContent = `Preparing ${formatBigBytes(total)}...`;

  try {
    if (mode === 'zero' && $('#xl-fast-zero').checked) {
      await writable.truncate(Number(total));
      if (cancelRequested) throw new DOMException('Cancelled', 'AbortError');
      await writable.close();
      $('#xl-progress').value = 100;
      $('#xl-status').textContent = `Created ${formatBigBytes(total)} zero-filled logical file. Physical allocation depends on the browser and filesystem.`;
      return;
    }

    const template = makeTemplate(mode);
    let written = 0n;
    let lastUi = performance.now();
    while (written < total) {
      if (cancelRequested) throw new DOMException('Cancelled', 'AbortError');
      const remaining = total - written;
      const length = Number(remaining < BigInt(template.length) ? remaining : BigInt(template.length));
      await writable.write(length === template.length ? template : template.subarray(0, length));
      written += BigInt(length);
      const now = performance.now();
      if (now - lastUi > 120 || written === total) {
        const pct = Number(written * 10000n / total) / 100;
        $('#xl-progress').value = pct;
        $('#xl-status').textContent = `${pct.toFixed(2)}% · ${formatBigBytes(written)} / ${formatBigBytes(total)}`;
        lastUi = now;
        await new Promise(requestAnimationFrame);
      }
    }
    await writable.close();
    $('#xl-progress').value = 100;
    $('#xl-status').textContent = `Finished writing ${formatBigBytes(total)}.`;
  } catch (e) {
    try { await writable.abort(); } catch {}
    if (e?.name === 'AbortError') $('#xl-status').textContent = 'Generation cancelled; uncommitted changes were discarded where supported.';
    else throw e;
  } finally {
    $('#xl-cancel').disabled = true;
    $('#xl-save').disabled = false;
  }
}

$('#xl-mode').addEventListener('change', updateModeUi);
$('#xl-size').addEventListener('input', updateSummary);
$('#xl-unit').addEventListener('change', updateSummary);
$('#xl-pattern').addEventListener('input', updateSummary);
$('#xl-seed').addEventListener('input', updateSummary);
$('#xl-copy-address').addEventListener('click', () => copyAddress().catch(e => $('#xl-status').textContent = e.message));
$('#xl-load-address').addEventListener('click', () => {
  try { parseAddress($('#xl-address-input').value); $('#xl-status').textContent = 'XL address loaded.'; }
  catch (e) { $('#xl-status').textContent = e.message; }
});
$('#xl-save').addEventListener('click', () => saveFile().catch(e => { $('#xl-status').textContent = e.message; $('#xl-cancel').disabled = true; $('#xl-save').disabled = false; }));
$('#xl-cancel').addEventListener('click', () => { cancelRequested = true; $('#xl-status').textContent = 'Cancelling...'; });

updateModeUi();
