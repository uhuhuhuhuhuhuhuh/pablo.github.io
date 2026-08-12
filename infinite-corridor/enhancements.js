import { pathToBytes, normalizePath, formatBytes } from './codec.js';

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function enhanceRegexResults() {
  const root = document.querySelector('#regex-results');
  if (!root) return;

  root.querySelectorAll('.regex-result').forEach((row, idx) => {
    if (row.dataset.enhanced === '1') return;
    const code = row.querySelector('code');
    if (!code) return;

    try {
      const path = code.textContent.trim();
      const bytes = pathToBytes(path);
      const depth = normalizePath(path).length;

      const meta = document.createElement('div');
      meta.className = 'regex-meta';
      meta.innerHTML = `<span>${formatBytes(bytes.length)}</span><span>${depth.toLocaleString()} levels</span>`;

      const first = row.querySelector('div');
      if (first) first.appendChild(meta);

      const download = document.createElement('button');
      download.className = 'secondary regex-download';
      download.textContent = 'Download';
      download.title = `Download ${formatBytes(bytes.length)} generated file`;
      download.addEventListener('click', () => downloadBytes(bytes, `corridor-regex-${idx + 1}.bin`));
      row.appendChild(download);
      row.dataset.enhanced = '1';
    } catch {
      // Leave malformed/unexpected rows untouched.
    }
  });
}

const observer = new MutationObserver(enhanceRegexResults);
const regexRoot = document.querySelector('#regex-results');
if (regexRoot) observer.observe(regexRoot, { childList: true, subtree: true });
enhanceRegexResults();
