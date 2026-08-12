import { bytesToPath, normalizePath, estimatedDepth, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const MAX_LITERAL_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 1024 ** 4; // 1 TiB
const HARD_REPEAT_CAP = 4096;
const HARD_BUDGET = 10_000_000;
const MAX_RESULTS = 500;

let currentResults = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function regexParts(raw) {
  raw = raw.trim();
  if (!raw) throw new Error('Enter a filename regex.');
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/');
    if (last > 0) return { source: raw.slice(1, last), flags: raw.slice(last + 1).replace(/[gy]/g, '') };
  }
  return { source: raw, flags: '' };
}

class FilenameRegexParser {
  constructor(source, repeatCap) {
    this.s = source;
    this.i = 0;
    this.repeatCap = repeatCap;
  }

  parse() {
    const node = this.expression();
    if (this.i !== this.s.length) throw new Error(`Unexpected token near ${this.s.slice(this.i, this.i + 16)}`);
    return node;
  }

  expression(stop = '') {
    const alts = [this.sequence(stop)];
    while (this.s[this.i] === '|') {
      this.i++;
      alts.push(this.sequence(stop));
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', a: alts };
  }

  sequence(stop) {
    const items = [];
    while (this.i < this.s.length && this.s[this.i] !== stop && this.s[this.i] !== '|') {
      items.push(this.quantified(this.atom()));
    }
    return { t: 'seq', a: items };
  }

  atom() {
    const c = this.s[this.i++];
    if (c === '(') {
      if (this.s.slice(this.i, this.i + 2) === '?:') this.i += 2;
      else if (this.s[this.i] === '?') throw new Error('Lookarounds are valid for matching but cannot be generatively enumerated. Rewrite the pattern without lookarounds.');
      const node = this.expression(')');
      if (this.s[this.i++] !== ')') throw new Error('Unclosed group.');
      return node;
    }
    if (c === '[') return { t: 'set', a: this.charClass() };
    if (c === '.') return { t: 'set', a: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.'] };
    if (c === '\\') return { t: 'set', a: this.escapeSet() };
    if (c === '^' || c === '$') return { t: 'lit', v: '' };
    if ('*+?{}'.includes(c)) throw new Error(`Quantifier ${c} has no target.`);
    if (c === undefined) throw new Error('Unexpected end of regex.');
    return { t: 'lit', v: c };
  }

  escapeSet() {
    const c = this.s[this.i++];
    if (c === 'd') return [...'0123456789'];
    if (c === 'w') return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'];
    if (c === 's') return [' ', '\t'];
    if (c === 'n') return ['\n'];
    if (c === 'r') return ['\r'];
    if (c === 't') return ['\t'];
    if (!c) throw new Error('Trailing escape.');
    if (/^[1-9]$/.test(c)) throw new Error('Backreferences cannot be generatively enumerated.');
    return [c];
  }

  charClass() {
    const negated = this.s[this.i] === '^';
    if (negated) throw new Error('Negated character classes cannot be generatively enumerated safely.');
    const out = [];
    let first = true;
    while (this.i < this.s.length && (this.s[this.i] !== ']' || first)) {
      first = false;
      let start;
      if (this.s[this.i] === '\\') {
        this.i++;
        const set = this.escapeSet();
        if (set.length > 1) {
          out.push(...set);
          continue;
        }
        start = set[0];
      } else {
        start = this.s[this.i++];
      }
      if (this.s[this.i] === '-' && this.s[this.i + 1] !== ']') {
        this.i++;
        let end;
        if (this.s[this.i] === '\\') {
          this.i++;
          const set = this.escapeSet();
          if (set.length !== 1) throw new Error('Character-class range endpoint must be one character.');
          end = set[0];
        } else end = this.s[this.i++];
        for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code++) out.push(String.fromCharCode(code));
      } else out.push(start);
    }
    if (this.s[this.i++] !== ']') throw new Error('Unclosed character class.');
    if (!out.length) throw new Error('Empty character class.');
    return [...new Set(out)];
  }

  quantified(node) {
    const c = this.s[this.i];
    if (!c || !'*+?{'.includes(c)) return node;
    let min;
    let max;
    if (c === '?') {
      this.i++;
      min = 0; max = 1;
    } else if (c === '*') {
      this.i++;
      min = 0; max = this.repeatCap;
    } else if (c === '+') {
      this.i++;
      min = 1; max = this.repeatCap;
    } else {
      this.i++;
      const m = this.s.slice(this.i).match(/^(\d+)(?:,(\d*)?)?\}/);
      if (!m) throw new Error('Invalid {m,n} quantifier.');
      this.i += m[0].length;
      min = Number(m[1]);
      max = m[0].includes(',') ? (m[2] ? Number(m[2]) : Math.max(min, this.repeatCap)) : min;
      if (min > HARD_REPEAT_CAP || max > HARD_REPEAT_CAP) throw new Error(`A single repetition is capped at ${HARD_REPEAT_CAP.toLocaleString()}.`);
    }
    if (max < min) throw new Error('Quantifier maximum is smaller than minimum.');
    return { t: 'rep', n: node, min, max };
  }
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function biasedCount(min, max, mode) {
  if (max <= min) return min;
  const span = max - min;
  if (mode === 'max') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.28) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}

function generateName(node, mode) {
  if (node.t === 'lit') return node.v;
  if (node.t === 'set') return pick(node.a);
  if (node.t === 'seq') return node.a.map(x => generateName(x, mode)).join('');
  if (node.t === 'alt') return generateName(pick(node.a), mode);
  if (node.t === 'rep') {
    const count = biasedCount(node.min, node.max, mode);
    let out = '';
    for (let i = 0; i < count; i++) out += generateName(node.n, mode);
    return out;
  }
  return '';
}

function unescapeLiteral(text) {
  return text.replace(/\\([\\.^$|?*+(){}\[\]-])/g, '$1');
}

function detectSimpleNumericPattern(source) {
  const m = source.match(/^([^\[|()]*)\[0-9\]\{(\d+)\}([^\[|()]*)$/);
  if (!m) return null;
  const width = Number(m[2]);
  if (!Number.isInteger(width) || width < 1 || width > 15) return null;
  return { prefix: unescapeLiteral(m[1]), width, suffix: unescapeLiteral(m[3]) };
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

function fillDeterministicBytes(size, seedText) {
  const out = new Uint8Array(size);
  let x = fnv1a(seedText);
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function chooseSize(min, max, mode) {
  if (max <= min) return min;
  const span = max - min;
  if (mode === 'max') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.25) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}

function makeSeed(filename, size, ordinal) {
  return `babel-regex|${filename}|${size}|${ordinal}`;
}

function makeLargeRecipe(filename, size, ordinal) {
  const seed = makeSeed(filename, size, ordinal);
  return { seed, address: `ICXL1:${size}:seeded:${base64urlEncode(seed)}` };
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'corridor-candidate.bin';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderResults(results, attempts) {
  currentResults = results;
  const literalCount = results.filter(x => x.kind === 'literal').length;
  const virtualCount = results.length - literalCount;
  const summary = `<div class="notice"><strong>${results.length.toLocaleString()} Babel candidates</strong><br><span class="muted">${attempts.toLocaleString()} candidate attempts · ${literalCount.toLocaleString()} literal paths · ${virtualCount.toLocaleString()} XL recipes. Filenames are generated from the regex; candidate bytes are deterministic from filename + size + candidate seed.</span></div>`;
  const rows = results.map((r, idx) => {
    const address = r.kind === 'literal' ? r.path : r.recipe;
    const shown = address.length > 520 ? `${address.slice(0, 250)}…${address.slice(-250)}` : address;
    return `<article class="regex-result" data-babel-result="${idx}">
      <div><span class="eyebrow">${r.kind === 'literal' ? 'Literal Babel candidate' : 'Large virtual candidate'}</span><strong>${escapeHtml(r.filename)}</strong><div class="regex-meta"><span>${formatBytes(r.size)}</span><span>${r.depth.toLocaleString()} levels${r.kind === 'virtual' ? ' estimated' : ''}</span></div></div>
      <code title="${escapeHtml(address)}">${escapeHtml(shown)}</code>
      <div class="button-row" style="margin-top:0"><button class="secondary babel-copy" data-i="${idx}">Copy ${r.kind === 'literal' ? 'address' : 'recipe'}</button>${r.kind === 'literal' ? `<button class="secondary babel-download" data-i="${idx}">Download</button>` : `<button class="secondary babel-open-xl" data-i="${idx}">Open in XL</button>`}</div>
    </article>`;
  }).join('');
  $('#regex-results').innerHTML = summary + rows;

  document.querySelectorAll('.babel-copy').forEach(btn => {
    btn.onclick = async () => {
      const r = currentResults[Number(btn.dataset.i)];
      await navigator.clipboard.writeText(r.kind === 'literal' ? r.path : r.recipe);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 900);
    };
  });

  document.querySelectorAll('.babel-download').forEach(btn => {
    btn.onclick = () => {
      const r = currentResults[Number(btn.dataset.i)];
      downloadBytes(r.bytes, r.filename);
    };
  });

  document.querySelectorAll('.babel-open-xl').forEach(btn => {
    btn.onclick = () => {
      const r = currentResults[Number(btn.dataset.i)];
      $('#xl-size').value = String(r.size);
      $('#xl-unit').value = 'B';
      $('#xl-mode').value = 'seeded';
      $('#xl-seed').value = r.seed;
      $('#xl-filename').value = r.filename;
      $('#xl-mode').dispatchEvent(new Event('change'));
      $('#xl-size').dispatchEvent(new Event('input'));
      $('#xl-seed').dispatchEvent(new Event('input'));
      document.querySelector('[data-tab="xl"]')?.click();
    };
  });
}

async function runBabelRegexSearch() {
  const button = $('#regex-generate');
  const status = $('#babel-regex-status');
  const target = $('#regex-results');
  try {
    const raw = $('#regex-input').value;
    const { source, flags } = regexParts(raw);
    const repeatCap = Math.max(1, Math.min(HARD_REPEAT_CAP, Number($('#regex-repeat-cap').value) || 256));
    const ast = new FilenameRegexParser(source, repeatCap).parse();
    const validator = new RegExp(`^(?:${source})$`, flags.replace(/[gy]/g, ''));
    const simpleNumeric = detectSimpleNumericPattern(source);
    const numericStart = Math.max(0, Number($('#regex-numeric-start').value) || 0);
    const count = Math.min(MAX_RESULTS, Math.max(1, Number($('#regex-count').value) || 100));
    const budget = Math.min(HARD_BUDGET, Math.max(1, Number($('#regex-budget').value) || 5000));
    const minBytes = Math.max(0, Math.min(HARD_MAX_BYTES, Number($('#regex-min-bytes').value) || 0));
    const maxBytes = Math.max(1, Math.min(HARD_MAX_BYTES, Number($('#regex-max-bytes').value) || 65536));
    const mode = $('#regex-depth-mode').value;
    if (minBytes > maxBytes) throw new Error('Minimum bytes cannot be larger than maximum bytes.');

    button.disabled = true;
    target.innerHTML = '<div class="notice">Exploring Babel candidates…</div>';
    status.textContent = 'Starting candidate search…';

    const seen = new Set();
    const results = [];
    let attempts = 0;
    const numericLimit = simpleNumeric ? 10 ** simpleNumeric.width : 0;

    while (attempts < budget && results.length < count) {
      let filename;
      if (simpleNumeric) {
        const n = (numericStart + attempts) % numericLimit;
        filename = `${simpleNumeric.prefix}${String(n).padStart(simpleNumeric.width, '0')}${simpleNumeric.suffix}`;
      } else {
        filename = generateName(ast, mode);
      }
      attempts++;

      validator.lastIndex = 0;
      if (!validator.test(filename)) continue;

      const size = chooseSize(minBytes, maxBytes, mode);
      const key = `${filename}\0${size}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const ordinal = attempts - 1;
      const depth = estimatedDepth(size);
      if (size <= MAX_LITERAL_BYTES) {
        const seed = makeSeed(filename, size, ordinal);
        const bytes = fillDeterministicBytes(size, seed);
        const path = bytesToPath(bytes);
        results.push({ kind: 'literal', filename, size, depth: normalizePath(path).length, bytes, path, seed, ordinal });
      } else {
        const large = makeLargeRecipe(filename, size, ordinal);
        results.push({ kind: 'virtual', filename, size, depth, recipe: large.address, seed: large.seed, ordinal });
      }

      if (attempts % 250 === 0) {
        status.textContent = `${attempts.toLocaleString()} / ${budget.toLocaleString()} attempts · ${results.length.toLocaleString()} results`;
        await new Promise(requestAnimationFrame);
      }
    }

    if (!results.length) {
      target.innerHTML = '<div class="notice warn">No candidates were generated under the current regex and size constraints.</div>';
      status.textContent = `Finished ${attempts.toLocaleString()} attempts with no results.`;
      return;
    }

    results.sort((a, b) => mode === 'balanced' ? a.ordinal - b.ordinal : b.size - a.size || a.ordinal - b.ordinal);
    renderResults(results, attempts);
    const largest = results.reduce((a, b) => a.size >= b.size ? a : b);
    status.textContent = `Finished ${attempts.toLocaleString()} attempts · ${results.length.toLocaleString()} results · largest ${formatBytes(largest.size)} / ${largest.depth.toLocaleString()} levels.`;
  } catch (error) {
    target.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    status.textContent = 'Search stopped because the regex or byte constraints are invalid.';
  } finally {
    button.disabled = false;
  }
}

function installUi() {
  const panel = $('#panel-regex');
  const tab = document.querySelector('[data-tab="regex"]');
  if (!panel || !tab) return;

  tab.textContent = 'Babel Regex';
  panel.innerHTML = `
    <div class="card">
      <span class="eyebrow">Filename → candidate bytes → Babel address</span>
      <h3>Babel regex candidate search</h3>
      <p class="help">Generate candidate filenames from a regex, choose a byte-size range, then deterministically generate candidate bytes and map them through the same Babel-compatible byte-to-path codec used by Infinite Corridor. This explores the mathematical Babel address space; it does not claim that a generated filename corresponds to a real external file.</p>
      <div class="grid-2">
        <div><label for="regex-input">Filename regex</label><input id="regex-input" class="mono" type="text" value="EFTA[0-9]{8}\\.pdf"></div>
        <div><label for="regex-count">Results</label><input id="regex-count" type="number" min="1" max="${MAX_RESULTS}" value="100"></div>
      </div>
      <div class="grid-3" style="margin-top:16px">
        <div><label for="regex-min-bytes">Minimum bytes</label><input id="regex-min-bytes" type="number" min="0" max="${HARD_MAX_BYTES}" value="1"></div>
        <div><label for="regex-max-bytes">Maximum bytes (up to 1 TiB)</label><input id="regex-max-bytes" type="number" min="1" max="${HARD_MAX_BYTES}" value="65536"></div>
        <div><label for="regex-depth-mode">Size/depth bias</label><select id="regex-depth-mode" class="input"><option value="deep" selected>Bias larger/deeper</option><option value="max">Always maximum bytes</option><option value="balanced">Balanced/random</option></select></div>
        <div><label for="regex-budget">Candidate attempts (up to 10,000,000)</label><input id="regex-budget" type="number" min="1" max="${HARD_BUDGET}" value="5000"></div>
        <div><label for="regex-repeat-cap">Open-ended regex repeat cap</label><input id="regex-repeat-cap" type="number" min="1" max="${HARD_REPEAT_CAP}" value="256"></div>
        <div><label for="regex-numeric-start">Numeric start / offset</label><input id="regex-numeric-start" type="number" min="0" value="0"></div>
      </div>
      <div class="notice" style="margin-top:16px"><strong>Numeric patterns:</strong> simple fixed-width patterns such as <code>EFTA[0-9]{8}\\.pdf</code> are enumerated sequentially. Set Numeric start to <code>2822476</code> to begin at <code>EFTA02822476.pdf</code>.</div>
      <div class="button-row"><button id="regex-generate">Search Babel candidates</button></div>
      <div id="babel-regex-status" class="muted" style="margin-top:12px">Ready.</div>
    </div>
    <div id="regex-results"><div class="notice">Enter a filename regex and byte-size constraints, then search the Babel candidate space.</div></div>`;

  $('#regex-generate').onclick = runBabelRegexSearch;
  $('#regex-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') runBabelRegexSearch();
  });
}

installUi();
