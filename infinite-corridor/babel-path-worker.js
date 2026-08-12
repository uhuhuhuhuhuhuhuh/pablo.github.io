import { bytesToPath } from './codec.js';

self.onmessage = (event) => {
  const { id, buffer } = event.data || {};
  try {
    const bytes = new Uint8Array(buffer);
    const started = performance.now();
    const path = bytesToPath(bytes);
    const depth = Math.max(0, path.split('/').length - 2);
    self.postMessage({ id, ok: true, path, depth, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
