#!/usr/bin/env node
// Print candidate source URLs for `tools/corpus.mjs add`, one per line.
//
//   node tools/corpus_candidates.mjs npm   [--packages 1000] [--min-kib 256]   big files from the most-used jsDelivr npm packages
//   node tools/corpus_candidates.mjs gguf  [--repos 300] [--max 40]            Q4_K_M quants of popular small models
//
// Every URL is pinned to an exact package version, commit or revision, so the
// bytes behind it cannot change and IC2C shares that reference it stay valid.
// Both hosts answer CORS Range requests, which the receiver page requires.
const UA = { 'User-Agent': 'InfiniteCorridorCorpus/1.0 (https://github.com/uhuhuhuhuhuhuhuh/pablo.github.io)' };
const MAX_SOURCE_BYTES = 2.25 * 1024 ** 3;
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const warn = (...a) => console.error(...a);

async function json(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status} ${url}`);
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}
async function mapLimit(items, limit, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch (e) { warn('skip', items[i], e.message); } } }));
  return out;
}
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

async function npm() {
  const want = flag('packages', 1000), minBytes = flag('min-kib', 256) * 1024, perPage = 100;
  const names = [];
  for (let page = 1; names.length < want; page++) {
    const rows = await json(`https://data.jsdelivr.com/v1/stats/packages?type=npm&period=year&limit=${perPage}&page=${page}`);
    if (!rows.length) break;
    names.push(...rows.map(r => r.name));
  }
  const lists = await mapLimit(names.slice(0, want), 8, async name => {
    const { version } = await json(`https://data.jsdelivr.com/v1/packages/npm/${name}/resolved`);
    if (!version) return [];
    const { files } = await json(`https://data.jsdelivr.com/v1/packages/npm/${name}@${version}?structure=flat`);
    return files
      .filter(f => f.size >= minBytes && f.size <= MAX_SOURCE_BYTES && !/\.(map|d\.ts|md|txt)$/i.test(f.name))
      .sort((a, b) => b.size - a.size).slice(0, 12)
      .map(f => `https://cdn.jsdelivr.net/npm/${name}@${version}${encodePath(f.name)}`);
  });
  return lists.flat();
}

async function gguf() {
  const repos = await json(`https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=${flag('repos', 300)}`);
  const picks = await mapLimit(repos.map(r => r.id), 6, async id => {
    const info = await json(`https://huggingface.co/api/models/${id}?blobs=true`);
    // Only the main Q4_K_M quant (what most people download); skip projectors, draft and MTP heads.
    const pick = info.siblings.find(s => /Q4_K_M\.gguf$/i.test(s.rfilename) && !s.rfilename.includes('/') && s.size && s.size <= MAX_SOURCE_BYTES && !/mmproj|draft|mtp/i.test(s.rfilename));
    return pick && `https://huggingface.co/${id}/resolve/${info.sha}/${encodePath(pick.rfilename)}`;
  });
  return picks.filter(Boolean).slice(0, flag('max', 40));
}

const commands = { npm, gguf };
if (!commands[args[0]]) { warn('usage: corpus_candidates.mjs npm|gguf [options]'); process.exit(2); }
for (const url of await commands[args[0]]()) console.log(url);
