import { bytesToPath, pathToBytes, normalizePath, formatBytes } from './codec.js';

const $ = (s) => document.querySelector(s);
const encoder = new TextEncoder();
const HARD_MAX_BYTES = 1024 ** 4; // 1 TiB
const HARD_REPEAT_CAP = 4096;
const HARD_BUDGET = 10_000_000;

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function regexSource(raw) {
  raw = raw.trim();
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) return raw.slice(1, raw.lastIndexOf('/'));
  return raw;
}

class DeepRegexParser {
  constructor(source, repeatCap) {
    this.s = source;
    this.i = 0;
    this.repeatCap = repeatCap;
  }

  parse() {
    const node = this.expression();
    if (this.i !== this.s.length) throw new Error(`Unexpected token near ${this.s.slice(this.i, this.i + 12)}`);
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
      else if (this.s[this.i] === '?') throw new Error('Lookarounds and special groups are not supported.');
      const node = this.expression(')');
      if (this.s[this.i++] !== ')') throw new Error('Unclosed group.');
      return node;
    }
    if (c === '[') return { t: 'set', a: this.charClass() };
    if (c === '.') return { t: 'set', a: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.'] };
    if (c === '\\') return { t: 'set', a: this.escapeSet() };
    if (c === '^' || c === '$') return { t: 'lit', v: '' };
    if ('*+?{}'.includes(c)) throw new Error(`Quantifier ${c} has no target.`);
    if (c === undefined) throw new Error('Unexpected end of pattern.');
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
    if (/^[1-9]$/.test(c)) throw new Error('Backreferences are not supported.');
    return [c];
  }

  charClass() {
    if (this.s[this.i] === '^') throw new Error('Negated character classes are not supported.');
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
        const end = this.s[this.i++];
        for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code++) out.push(String.fromCharCode(code));
      } else {
        out.push(start);
      }
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
      min = 0;
      max = 1;
    } else if (c === '*') {
      this.i++;
      min = 0;
      max = this.repeatCap;
    } else if (c === '+') {
      this.i++;
      min = 1;
      max = Math.max(1, this.repeatCap);
    } else {
      this.i++;
      const match = this.s.slice(this.i).match(/^(\d+)(?:,(\d*)?)?\}/);
      if (!match) throw new Error('Invalid {m,n} quantifier.');
      this.i += match[0].length;
      min = Number(match[1]);
      max = match[0].includes(',')
        ? (match[2] ? Number(match[2]) : Math.max(min, this.repeatCap))
        : min;
      if (max > HARD_REPEAT_CAP || min > HARD_REPEAT_CAP) {
        throw new Error(`Deep regex caps a single repetition at ${HARD_REPEAT_CAP.toLocaleString()}.`);
      }
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
  if (mode === 'deepest') return max;
  if (mode === 'deep') return min + Math.floor(Math.pow(Math.random(), 0.28) * (span + 1));
  return min + Math.floor(Math.random() * (span + 1));
}

function generate(node, mode) {
  if (node.t === 'lit') return node.v;
  if (node.t === 'set') return pick(node.a);
  if (node.t === 'seq') return node.a.map(child => generate(child, mode)).join('');
  if (node.t === 'alt') return generate(pick(node.a), mode);
  if (node.t === 'rep') {
    const count = biasedCount(node.min, node.max, mode);
    let out = '';
    for (let i = 0; i < count; i++) out += generate(node.n, mode);
    return out;
  }
  return '';
}

function addDeepControls() {
  const panel = $('#panel-regex');
  const button = $('#regex-generate');
  const count = $('#regex-count');
  if (!panel || !button || !count || $('#regex-deep-controls')) return;

  count.max = '250';

  const controls = document.createElement('div');
  controls.id = 'regex-deep-controls';
  controls.innerHTML = `
    <div class="notice" style="margin-top:16px">
      <strong>Deep synthesis</strong><br>
      Instead of returning the first small examples, this mode generates a much larger candidate pool and ranks matches by decoded byte size / Corridor depth. It still synthesizes addresses mathematically; it does not scan stored files.
    </div>
    <div class="grid-3" style="margin-top:16px">
      <div><label for="regex-depth-mode">Depth bias</label><select id="regex-depth-mode" class="input"><option value="deep" selected>Deep</option><option value="deepest">Maximum depth</option><option value="balanced">Balanced</option></select></div>
      <div><label for="regex-min-bytes">Minimum bytes</label><input id="regex-min-bytes" type="number" min="0" max="${HARD_MAX_BYTES}" value="0"></div>
      <div><label for="regex-max-bytes">Maximum bytes (up to 1 TiB)</label><input id="regex-max-bytes" type="number" min="1" max="${HARD_MAX_BYTES}" value="4096"></div>
      <div><label for="regex-repeat-cap">Unbounded repeat cap</label><input id="regex-repeat-cap" type="number" min="1" max="${HARD_REPEAT_CAP}" value="256"></div>
      <div><label for="regex-budget">Candidate attempts (up to 10,000,000)</label><input id="regex-budget" type="number" min="100" max="${HARD_BUDGET}" value="5000"></div>
      <div><label>Ranking</label><div class="pill" style="display:inline-block">Largest/deepest first</div></div>
    </div>
    <div id="regex-deep-status" class="muted" style="margin-top:12px">Ready.</div>`;

  const buttonRow = button.closest('.button-row');
  buttonRow.parentNode.insertBefore(controls, buttonRow);
}

async function runDeepRegex() {
  const target = $('#regex-results');
  const button = $('#regex-generate');
  const status = $('#regex-deep-status');

  try {
    const mode = $('#regex-depth-mode')?.value || 'deep';
    const count = Math.min(250, Math.max(1, Number($('#regex-count').value) || 10));
    const minBytes = Math.max(0, Math.min(HARD_MAX_BYTES, Number($('#regex-min-bytes').value) || 0));
    const maxBytes = Math.max(1, Math.min(HARD_MAX_BYTES, Number($('#regex-max-bytes').value) || 4096));
    const repeatCap = Math.max(1, Math.min(HARD_REPEAT_CAP, Number($('#regex-repeat-cap').value) || 256));
    const budget = Math.max(100, Math.min(HARD_BUDGET, Number($('#regex-budget').value) || 5000));

    if (minBytes > maxBytes) throw new Error('Minimum bytes cannot be larger than maximum bytes.');

    const ast = new DeepRegexParser(regexSource($('#regex-input').value), repeatCap).parse();
    const seen = new Set();
    const candidates = [];
    const poolLimit = Math.max(1000, count * 25);
    const yieldEvery = budget > 500000 ? 2000 : budget > 100000 ? 1000 : 250;

    button.disabled = true;
    target.innerHTML = '<div class="notice">Synthesizing deeper regex candidates…</div>';
    if (status) status.textContent = `0 / ${budget.toLocaleString()} candidate attempts`;

    for (let attempt = 0; attempt < budget; attempt++) {
      const text = generate(ast, mode);
      if (!seen.has(text)) {
        seen.add(text);
        const byteLength = encoder.encode(text).length;
        if (byteLength >= minBytes && byteLength <= maxBytes) {
          candidates.push({ text, byteLength, tie: Math.random() });
        }
      }

      if (candidates.length > poolLimit * 2) {
        candidates.sort((a, b) => mode === 'balanced'
          ? b.tie - a.tie
          : b.byteLength - a.byteLength || b.tie - a.tie);
        candidates.length = poolLimit;
      }

      if ((attempt + 1) % yieldEvery === 0) {
        if (status) status.textContent = `${(attempt + 1).toLocaleString()} / ${budget.toLocaleString()} attempts · ${candidates.length.toLocaleString()} in byte range`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (!candidates.length) {
      target.innerHTML = `<div class="notice warn">No generated matches landed between ${formatBytes(minBytes)} and ${formatBytes(maxBytes)}. Lower the minimum byte size, raise the unbounded repeat cap, or use a pattern with <code>*</code>, <code>+</code>, or <code>{m,n}</code> so the match can actually grow.</div>`;
      if (status) status.textContent = `Finished ${budget.toLocaleString()} attempts with no in-range matches.`;
      return;
    }

    candidates.sort((a, b) => mode === 'balanced'
      ? b.tie - a.tie
      : b.byteLength - a.byteLength || b.tie - a.tie);

    const selected = candidates.slice(0, count).map(item => {
      const bytes = encoder.encode(item.text);
      const path = bytesToPath(bytes);
      return {
        ...item,
        bytes,
        path,
        depth: normalizePath(path).length
      };
    });

    target.innerHTML = selected.map((result, idx) => {
      const pathDisplay = result.path.length > 520
        ? `${result.path.slice(0, 250)}…${result.path.slice(-250)}`
        : result.path;
      return `<article class="regex-result" data-deep-result="${idx}">
        <div><span class="eyebrow">Deep match ${idx + 1}</span><strong>${escapeHtml(result.text).replaceAll(' ', '&nbsp;')}</strong><div class="regex-meta"><span>${formatBytes(result.byteLength)}</span><span>${result.depth.toLocaleString()} levels</span></div></div>
        <code title="Full Corridor address available with Copy">${escapeHtml(pathDisplay)}</code>
        <div class="button-row" style="margin-top:0"><button class="secondary deep-copy" data-i="${idx}">Copy</button><button class="secondary deep-download" data-i="${idx}">Download</button></div>
      </article>`;
    }).join('');

    target.querySelectorAll('.deep-copy').forEach(copy => {
      copy.addEventListener('click', async () => {
        const result = selected[Number(copy.dataset.i)];
        await navigator.clipboard.writeText(result.path);
        const original = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = original; }, 900);
      });
    });

    target.querySelectorAll('.deep-download').forEach(download => {
      download.addEventListener('click', () => {
        const index = Number(download.dataset.i);
        downloadBytes(selected[index].bytes, `corridor-regex-deep-${index + 1}.bin`);
      });
    });

    const largest = selected[0];
    if (status) status.textContent = `Synthesized ${budget.toLocaleString()} candidates · ${candidates.length.toLocaleString()} unique matches in range · showing ${selected.length.toLocaleString()} · deepest result ${formatBytes(largest.byteLength)} / ${largest.depth.toLocaleString()} levels.`;
  } catch (error) {
    target.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    if (status) status.textContent = 'Stopped because the pattern or depth settings are invalid.';
  } finally {
    button.disabled = false;
  }
}

function installDeepRegex() {
  addDeepControls();
  const button = $('#regex-generate');
  if (button) {
    button.textContent = 'Deep-search Corridor matches';
    button.onclick = runDeepRegex;
  }
}

installDeepRegex();
