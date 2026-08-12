import { createIcsToken, formatIcsBytes, inferMime } from './ics-share-codec.js?v=20260812share3';

const MAX_TOKEN_CHARS = 1_500_000;
const TOKEN_OVERHEAD_CHARS = 80;
const APPROX_RAW_PAYLOAD_BYTES = Math.floor((MAX_TOKEN_CHARS - TOKEN_OVERHEAD_CHARS) * 3 / 4);

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const fileCard = document.querySelector('#file-card');
const clearButton = document.querySelector('#clear-file');
const createButton = document.querySelector('#create-link');
const status = document.querySelector('#status');
const resultBox = document.querySelector('#share-result');
const shareLink = document.querySelector('#share-link');
const copyButton = document.querySelector('#copy-link');
const openButton = document.querySelector('#open-link');
const newLinkButton = document.querySelector('#new-link');

let selectedFile = null;
let currentUrl = '';
let busy = false;

function cleanFilename(name) {
  const cleaned = String(name || 'shared-file.bin').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  return (cleaned || 'shared-file.bin').slice(0, 255);
}

function extension(name) {
  const pieces = String(name).split('.');
  if (pieces.length < 2) return 'FILE';
  return pieces.pop().replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase() || 'FILE';
}

function buildShareUrl(token, filename) {
  if (token.length > MAX_TOKEN_CHARS) {
    throw new Error(`The encoded link would be ${token.length.toLocaleString()} characters, above the ${MAX_TOKEN_CHARS.toLocaleString()} character share-link safety limit. This file did not compress enough to fit in a self-contained URL.`);
  }
  const url = new URL('./s/', location.href);
  url.hash = `${token}/${encodeURIComponent(cleanFilename(filename))}`;
  return url.toString();
}

function compressionRequirement(fileSize) {
  if (fileSize <= APPROX_RAW_PAYLOAD_BYTES) {
    return `This file can fit even without compression. Final links are limited to ${MAX_TOKEN_CHARS.toLocaleString()} token characters.`;
  }

  const maxRatio = APPROX_RAW_PAYLOAD_BYTES / fileSize;
  const reduction = Math.max(0, (1 - maxRatio) * 100);
  return `No fixed source-file cap. To fit the ${MAX_TOKEN_CHARS.toLocaleString()}-character link limit, this file needs to compress by about ${reduction.toFixed(reduction >= 99 ? 2 : 1)}% or better.`;
}

function setBusy(value) {
  busy = value;
  createButton.disabled = value || !selectedFile;
  clearButton.disabled = value;
  dropZone.disabled = value;
  createButton.textContent = value ? 'Creating link…' : 'Create share link';
}

function showFile(file) {
  if (!file) return;
  selectedFile = file;
  currentUrl = '';
  resultBox.hidden = true;
  shareLink.value = '';

  document.querySelector('#file-name').textContent = file.name;
  document.querySelector('#file-size').textContent = formatIcsBytes(file.size);
  document.querySelector('#file-type').textContent = file.type || inferMime(file.name);
  document.querySelector('#file-ext').textContent = extension(file.name);

  dropZone.hidden = true;
  fileCard.hidden = false;
  clearButton.hidden = false;
  createButton.disabled = false;
  status.textContent = compressionRequirement(file.size);
}

function clearFile() {
  if (busy) return;
  selectedFile = null;
  currentUrl = '';
  fileInput.value = '';
  fileCard.hidden = true;
  dropZone.hidden = false;
  clearButton.hidden = true;
  createButton.disabled = true;
  resultBox.hidden = true;
  shareLink.value = '';
  status.textContent = `Choose a file to begin. There is no fixed source-file cap; the final token must stay under ${MAX_TOKEN_CHARS.toLocaleString()} characters.`;
}

async function createShare() {
  if (!selectedFile || busy) return;

  setBusy(true);
  resultBox.hidden = true;
  status.textContent = `Reading ${selectedFile.name} locally… Large files can use substantial browser memory.`;

  try {
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    status.textContent = `Compressing and packing ${formatIcsBytes(bytes.length)} into a self-contained link…`;
    await new Promise(requestAnimationFrame);

    const encoded = await createIcsToken(bytes);
    const url = buildShareUrl(encoded.token, selectedFile.name);
    currentUrl = url;
    shareLink.value = url;

    const modeText = encoded.mode === 'G'
      ? `${formatIcsBytes(encoded.originalBytes)} compressed to ${formatIcsBytes(encoded.packedBytes)}`
      : `${formatIcsBytes(encoded.originalBytes)} stored as a raw reversible payload`;

    document.querySelector('#share-summary').textContent = `${modeText} · ${url.length.toLocaleString()} URL characters`;
    resultBox.hidden = false;
    status.textContent = 'Ready to share. Creating another link for the same file will use a new random salt.';
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    currentUrl = '';
    resultBox.hidden = true;
    status.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

async function copyCurrentLink() {
  if (!currentUrl) return;
  try {
    await navigator.clipboard.writeText(currentUrl);
  } catch {
    shareLink.focus();
    shareLink.select();
    document.execCommand('copy');
  }
  const old = copyButton.textContent;
  copyButton.textContent = 'Copied';
  setTimeout(() => { copyButton.textContent = old; }, 1000);
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  if (!busy) dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  if (busy) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) showFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) showFile(file);
});

clearButton.addEventListener('click', clearFile);
createButton.addEventListener('click', createShare);
copyButton.addEventListener('click', copyCurrentLink);
openButton.addEventListener('click', () => {
  if (currentUrl) window.open(currentUrl, '_blank', 'noopener,noreferrer');
});
newLinkButton.addEventListener('click', createShare);
