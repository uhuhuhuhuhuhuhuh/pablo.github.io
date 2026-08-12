import {
  MAX_TOKEN_CHARS, FASTCDC, BinWriter, BinReader,
  bytesToBase64Url, base64UrlToBytes, equalBytes, hex, Sha256, sha256
} from './ic2-util.js';
import {
  CODEC, compressBest, compressOuter, decompressOuter, decompressByCodec,
  compressWithDictionary, decompressWithDictionary
} from './compression.js';

export const IC2_FORMAT_VERSION = 3;
export const KIND = Object.freeze({
  RAW:0, COMPRESSED:1, ZERO:2, CONSTANT:3, REPEAT:4, COUNTER8:5,
  REF:6, DELTA_XOR:7, DELTA_SPLICE:8, COMPRESSED_DICT:9
});
export const KIND_NAME = Object.freeze({
  0:'raw',1:'compressed',2:'zero recipe',3:'constant recipe',4:'repeat recipe',5:'counter recipe',
  6:'deduplicated reference',7:'xor delta',8:'splice delta',9:'learned dictionary'
});

const MAGIC = Uint8Array.of(0x49,0x43,0x32,0x42);
const HASH_ALGO_SHA256 = 1;
const LINK_BINARY_BUDGET = Math.floor(MAX_TOKEN_CHARS * 3 / 4) - 2048;
const RECENT_LIMIT = 16;
const DELTA_CANDIDATES = 2;
const MAX_REPEAT_PATTERN = 256;
const MAX_DICTIONARY_BYTES = 64 * 1024;
const LEARNING_SAMPLE_BYTES = 2048;
const MAX_LEARNING_SAMPLES = 20;

const GEAR = (() => {
  const t = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i=0;i<256;i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    t[i] = x >>> 0;
  }
  return t;
})();

function isCancelled(signal) { return !!signal?.cancelled; }
function cancelCheck(signal) { if (isCancelled(signal)) throw new Error('Encoding cancelled.'); }
function makeSalt() { const s = new Uint8Array(16); crypto.getRandomValues(s); return s; }

function sampleSimilarity(a,b) {
  const min = Math.min(a.length,b.length);
  if (!min) return 0;
  let same=0, checks=32;
  for (let i=0;i<checks;i++) {
    const p = Math.min(min-1, Math.floor((i + 0.5) * min / checks));
    if (a[p] === b[p]) same++;
  }
  const sizePenalty = Math.abs(a.length-b.length) / Math.max(a.length,b.length);
  return same/checks - sizePenalty*0.5;
}

function detectRecipe(bytes) {
  if (!bytes.length) return null;
  const first = bytes[0];
  let same = true;
  for (let i=1;i<bytes.length;i++) if (bytes[i] !== first) { same=false; break; }
  if (same) return first === 0 ? {kind:KIND.ZERO} : {kind:KIND.CONSTANT, value:first};
  let counter = true;
  for (let i=1;i<bytes.length;i++) if (bytes[i] !== ((first+i)&255)) { counter=false; break; }
  if (counter) return {kind:KIND.COUNTER8, start:first};
  for (const p of [2,4,8,16,32,64,128,256]) {
    if (p > MAX_REPEAT_PATTERN || bytes.length < p*2 || bytes.length % p) continue;
    let ok=true;
    for (let i=p;i<bytes.length;i++) if (bytes[i] !== bytes[i%p]) { ok=false; break; }
    if (ok) return {kind:KIND.REPEAT, pattern:bytes.slice(0,p)};
  }
  return null;
}

function encodedPayloadBytes(seg) {
  if ([KIND.RAW,KIND.COMPRESSED,KIND.DELTA_XOR,KIND.DELTA_SPLICE,KIND.COMPRESSED_DICT].includes(seg.kind)) return seg.data.length;
  if (seg.kind===KIND.REPEAT) return seg.pattern.length;
  return 0;
}
function estimateManifestBytes(segments, embedded, dictionaryBytes=0) { return 80 + dictionaryBytes + embedded + segments.length * 42; }

async function deltaCandidates(bytes, recent) {
  if (!recent.length) return [];
  return recent.filter(r => Math.max(r.bytes.length, bytes.length) <= Math.min(r.bytes.length, bytes.length) * 1.35)
    .map(r => ({...r, score:sampleSimilarity(bytes,r.bytes)})).sort((a,b)=>b.score-a.score).slice(0,DELTA_CANDIDATES);
}

async function buildDelta(bytes, candidate) {
  const base = candidate.bytes, options=[];
  if (base.length === bytes.length) {
    const xor = new Uint8Array(bytes.length); let nonzero=0;
    for(let i=0;i<bytes.length;i++){const v=bytes[i]^base[i];xor[i]=v;if(v)nonzero++;}
    if (nonzero < bytes.length * 0.72) {
      const c = await compressBest(xor, 5);
      options.push({kind:KIND.DELTA_XOR, base:candidate.segmentIndex, codec:c.codec, data:c.data, cost:c.data.length+12});
    }
  }
  const min=Math.min(base.length,bytes.length); let pre=0;
  while(pre<min && base[pre]===bytes[pre]) pre++;
  let suf=0; while(suf<min-pre && base[base.length-1-suf]===bytes[bytes.length-1-suf]) suf++;
  if (pre+suf >= Math.min(32, min/4)) {
    const middle=bytes.slice(pre,bytes.length-suf), c=await compressBest(middle,5);
    options.push({kind:KIND.DELTA_SPLICE,base:candidate.segmentIndex,prefix:pre,suffix:suf,codec:c.codec,data:c.data,cost:c.data.length+20});
  }
  options.sort((a,b)=>a.cost-b.cost); return options[0] || null;
}

function literalFromCompression(compressed, bytes) {
  return compressed.codec===CODEC.RAW
    ? {kind:KIND.RAW,data:bytes,cost:bytes.length+8}
    : {kind:KIND.COMPRESSED,codec:compressed.codec,data:compressed.data,cost:compressed.data.length+10};
}

async function chooseRepresentation(bytes, hashBytes, seen, recent, dictionary) {
  const recipe=detectRecipe(bytes);
  if (recipe) return {...recipe, cost: recipe.kind===KIND.REPEAT ? recipe.pattern.length+8 : 8};
  const h=hex(hashBytes), duplicate=seen.get(h);
  if (duplicate && duplicate.unitLen===bytes.length) return {kind:KIND.REF,base:duplicate.segmentIndex,cost:8};

  const compressed=await compressBest(bytes,8);
  let fallback=literalFromCompression(compressed,bytes);
  for (const c of await deltaCandidates(bytes,recent)) {
    const d=await buildDelta(bytes,c);
    if (d && d.cost + 8 < fallback.cost) fallback=d;
  }

  if (dictionary?.length) {
    const dictData=await compressWithDictionary(bytes,dictionary,8);
    if (dictData && dictData.length + 14 < fallback.cost) {
      return {
        kind:KIND.COMPRESSED_DICT, data:dictData, cost:dictData.length+10,
        fallback, dictSavings:Math.max(0,fallback.cost-(dictData.length+10))
      };
    }
  }
  return fallback;
}

function addStats(stats, seg, rawBytes, repeat=false) {
  stats.chunks++;
  stats.rawBytes += rawBytes;
  const key = repeat ? 'runDedup' : (KIND_NAME[seg.kind] || 'unknown');
  stats.byKind[key] = (stats.byKind[key] || 0) + rawBytes;
}

function rebuildRepresentationStats(stats, segments) {
  const byKind={};
  for (const s of segments) {
    const name=KIND_NAME[s.kind] || 'unknown';
    const bytes=s.unitLen * s.repeatCount;
    byKind[name]=(byKind[name]||0)+bytes;
  }
  stats.byKind=byKind;
}

function maybeLearningSample(chunk, rep, samples) {
  if (samples.length>=MAX_LEARNING_SAMPLES || chunk.length<1024) return;
  const payload=encodedPayloadBytes(rep);
  if (!payload || payload/chunk.length>0.92) return;
  const span=Math.min(LEARNING_SAMPLE_BYTES,chunk.length);
  const maxStart=chunk.length-span;
  const start=maxStart ? Math.floor((samples.length*2654435761 % 997)/996*maxStart) : 0;
  const data=chunk.slice(start,start+span);
  samples.push({hash:hex(sha256(data)),data});
}

function finalizeDictionary(segments, dictionary, stats) {
  if (!dictionary?.length) return new Uint8Array();
  let savings=0, uses=0;
  for (const s of segments) if (s.kind===KIND.COMPRESSED_DICT) { savings += s.dictSavings||0; uses++; }
  const overhead=dictionary.length+16;
  if (!uses || savings<=overhead) {
    for (let i=0;i<segments.length;i++) {
      const s=segments[i];
      if (s.kind!==KIND.COMPRESSED_DICT) continue;
      const base={...s.fallback,unitLen:s.unitLen,repeatCount:s.repeatCount,hash:s.hash};
      delete base.cost; delete base.fallback; delete base.dictSavings;
      segments[i]=base;
    }
    stats.knowledge.dictionaryUsed=false;
    stats.knowledge.dictionarySavings=0;
    stats.knowledge.dictionaryUses=0;
    return new Uint8Array();
  }
  for (const s of segments) { delete s.fallback; delete s.dictSavings; }
  stats.knowledge.dictionaryUsed=true;
  stats.knowledge.dictionarySavings=savings-overhead;
  stats.knowledge.dictionaryUses=uses;
  return dictionary;
}

export async function encodeFileToIc2(file, {onProgress=()=>{}, signal=null, knowledge=null}={}) {
  if (!file || typeof file.stream !== 'function') throw new Error('A browser File is required.');
  const candidateDictionary=knowledge?.dictionary instanceof Uint8Array
    ? knowledge.dictionary.slice(0,MAX_DICTIONARY_BYTES)
    : new Uint8Array();
  const salt=makeSalt(), fileHasher=new Sha256(), segments=[], seen=new Map(), recent=[], learningSamples=[];
  let embedded=0, bytesSeen=0;
  const stats={
    chunks:0,segments:0,rawBytes:0,embeddedBytes:0,byKind:{},fastcdc:FASTCDC,
    knowledge:{profile:knowledge?.profile||'',sampleCount:knowledge?.sampleCount||0,observedFiles:knowledge?.observedFiles||0,availableDictionaryBytes:candidateDictionary.length,dictionaryUsed:false,dictionarySavings:0,dictionaryUses:0}
  };
  const current=new Uint8Array(FASTCDC.max); let currentLen=0, gear=0;
  const processChunk=async (chunk) => {
    cancelCheck(signal);
    const hashBytes=sha256(chunk), hashHex=hex(hashBytes), prev=segments[segments.length-1];
    if (prev && prev.unitLen===chunk.length && equalBytes(prev.hash,hashBytes)) {
      prev.repeatCount++; addStats(stats,prev,chunk.length,true);
      const idx=segments.length-1; recent.push({bytes:chunk,segmentIndex:idx}); if(recent.length>RECENT_LIMIT)recent.shift();
      return;
    }
    const rep=await chooseRepresentation(chunk,hashBytes,seen,recent,candidateDictionary);
    maybeLearningSample(chunk,rep,learningSamples);
    const seg={...rep,unitLen:chunk.length,repeatCount:1,hash:hashBytes}; delete seg.cost;
    const idx=segments.length; segments.push(seg); embedded += encodedPayloadBytes(seg); addStats(stats,seg,chunk.length,false);
    if (!seen.has(hashHex)) seen.set(hashHex,{segmentIndex:idx,unitLen:chunk.length});
    recent.push({bytes:chunk,segmentIndex:idx}); if(recent.length>RECENT_LIMIT)recent.shift();
    if (estimateManifestBytes(segments,embedded,candidateDictionary.length) > LINK_BINARY_BUDGET * 1.12) {
      const e=new Error('This file already contains more novel encoded information than can fit in the current 1,500,000-character self-contained link budget.');
      e.code='IC2_LINK_BUDGET'; throw e;
    }
  };
  const flush=async()=>{ if(!currentLen)return; const chunk=current.slice(0,currentLen); currentLen=0;gear=0; await processChunk(chunk); };
  const reader=file.stream().getReader();
  while(true){
    cancelCheck(signal);
    const {value,done}=await reader.read(); if(done)break;
    const input=value instanceof Uint8Array?value:new Uint8Array(value); fileHasher.update(input); bytesSeen += input.length;
    for(let i=0;i<input.length;i++){
      const b=input[i]; current[currentLen++]=b; gear=((gear<<1)+GEAR[b])>>>0;
      if(currentLen>=FASTCDC.min){ const mask=currentLen<FASTCDC.avg?0x1ffff:0x7fff; if(currentLen>=FASTCDC.max || (gear&mask)===0) await flush(); }
    }
    onProgress({phase:'analyze',done:bytesSeen,total:file.size,segments:segments.length,stats});
  }
  await flush();
  const fileHash=fileHasher.digest();
  const dictionary=finalizeDictionary(segments,candidateDictionary,stats);
  embedded=segments.reduce((n,s)=>n+encodedPayloadBytes(s),0);
  rebuildRepresentationStats(stats,segments);
  stats.segments=segments.length; stats.embeddedBytes=embedded; stats.knowledge.embeddedDictionaryBytes=dictionary.length;
  const manifest={version:IC2_FORMAT_VERSION,salt,totalSize:file.size,fileHash,dictionary,segments};
  const binary=encodeManifest(manifest);
  onProgress({phase:'pack',done:file.size,total:file.size,segments:segments.length,stats,manifestBytes:binary.length});
  const outer=await compressOuter(binary), token=`IC2.${outer.mode}.${bytesToBase64Url(outer.data)}`;
  if(token.length>MAX_TOKEN_CHARS){const e=new Error(`The optimized IC2 descriptor is ${token.length.toLocaleString()} characters, above the ${MAX_TOKEN_CHARS.toLocaleString()}-character link limit.`);e.code='IC2_LINK_BUDGET';throw e;}
  return {token,manifest,binaryBytes:binary.length,packedBytes:outer.data.length,outerMode:outer.mode,stats,learningSamples};
}

export function encodeManifest(m) {
  const version=m.version||IC2_FORMAT_VERSION;
  const w=new BinWriter();
  w.bytes(MAGIC).u8(version).u8(HASH_ALGO_SHA256).u8(FASTCDC.version).bytes(m.salt).varint(m.totalSize).bytes(m.fileHash);
  if(version>=3){const dict=m.dictionary||new Uint8Array();w.varint(dict.length).bytes(dict);}
  w.varint(m.segments.length);
  for(const s of m.segments){
    w.u8(s.kind).varint(s.unitLen).varint(s.repeatCount).bytes(s.hash);
    if(s.kind===KIND.RAW){w.varint(s.data.length).bytes(s.data);}
    else if(s.kind===KIND.COMPRESSED){w.u8(s.codec).varint(s.data.length).bytes(s.data);}
    else if(s.kind===KIND.ZERO){}
    else if(s.kind===KIND.CONSTANT){w.u8(s.value);}
    else if(s.kind===KIND.REPEAT){w.varint(s.pattern.length).bytes(s.pattern);}
    else if(s.kind===KIND.COUNTER8){w.u8(s.start);}
    else if(s.kind===KIND.REF){w.varint(s.base);}
    else if(s.kind===KIND.DELTA_XOR){w.varint(s.base).u8(s.codec).varint(s.data.length).bytes(s.data);}
    else if(s.kind===KIND.DELTA_SPLICE){w.varint(s.base).varint(s.prefix).varint(s.suffix).u8(s.codec).varint(s.data.length).bytes(s.data);}
    else if(s.kind===KIND.COMPRESSED_DICT){w.varint(s.data.length).bytes(s.data);}
    else throw new Error(`Unknown IC2 segment kind ${s.kind}.`);
  }
  return w.finish();
}

export function decodeManifest(bytes) {
  const r=new BinReader(bytes);
  if(!equalBytes(r.take(4),MAGIC))throw new Error('Not an IC2 binary manifest.');
  const version=r.u8(); if(version!==2 && version!==3)throw new Error(`Unsupported IC2 version ${version}.`);
  const hashAlgo=r.u8(); if(hashAlgo!==HASH_ALGO_SHA256)throw new Error(`Unsupported IC2 hash algorithm ${hashAlgo}.`);
  const chunker=r.u8(); if(chunker!==FASTCDC.version)throw new Error(`Unsupported IC2 chunker version ${chunker}.`);
  const salt=r.take(16).slice(), totalSize=r.numberVarint('total size'), fileHash=r.take(32).slice();
  let dictionary=new Uint8Array();
  if(version>=3){const n=r.numberVarint('dictionary length');if(n>MAX_DICTIONARY_BYTES)throw new Error('IC2 dictionary is too large.');dictionary=r.take(n).slice();}
  const count=r.numberVarint('segment count'); if(count>100000)throw new Error('IC2 manifest has too many segments.');
  const segments=[]; let computed=0n;
  for(let i=0;i<count;i++){
    const kind=r.u8(), unitLen=r.numberVarint('segment length'), repeatCount=r.numberVarint('repeat count');
    if(unitLen<0 || unitLen>FASTCDC.max)throw new Error(`IC2 segment ${i} has invalid unit length.`);
    if(repeatCount<1)throw new Error(`IC2 segment ${i} has invalid repeat count.`);
    const hash=r.take(32).slice(), s={kind,unitLen,repeatCount,hash};
    if(kind===KIND.RAW){const n=r.numberVarint('raw payload');s.data=r.take(n).slice();if(n!==unitLen)throw new Error('RAW length mismatch.');}
    else if(kind===KIND.COMPRESSED){s.codec=r.u8();const n=r.numberVarint('compressed payload');s.data=r.take(n).slice();}
    else if(kind===KIND.ZERO){}
    else if(kind===KIND.CONSTANT){s.value=r.u8();}
    else if(kind===KIND.REPEAT){const n=r.numberVarint('pattern length');if(n<1||n>MAX_REPEAT_PATTERN)throw new Error('Invalid repeat pattern.');s.pattern=r.take(n).slice();}
    else if(kind===KIND.COUNTER8){s.start=r.u8();}
    else if(kind===KIND.REF){s.base=r.numberVarint('base index');if(s.base>=i)throw new Error('REF must point backward.');}
    else if(kind===KIND.DELTA_XOR){s.base=r.numberVarint('base index');if(s.base>=i)throw new Error('DELTA must point backward.');s.codec=r.u8();const n=r.numberVarint('delta payload');s.data=r.take(n).slice();}
    else if(kind===KIND.DELTA_SPLICE){s.base=r.numberVarint('base index');if(s.base>=i)throw new Error('DELTA must point backward.');s.prefix=r.numberVarint('prefix');s.suffix=r.numberVarint('suffix');s.codec=r.u8();const n=r.numberVarint('delta payload');s.data=r.take(n).slice();}
    else if(kind===KIND.COMPRESSED_DICT){if(version<3||!dictionary.length)throw new Error('Dictionary-compressed segment has no dictionary.');const n=r.numberVarint('dictionary payload');s.data=r.take(n).slice();}
    else throw new Error(`Unknown IC2 segment kind ${kind}.`);
    computed += BigInt(unitLen) * BigInt(repeatCount); segments.push(s);
  }
  if(!r.done)throw new Error('Unexpected trailing data in IC2 manifest.');
  if(computed!==BigInt(totalSize))throw new Error(`IC2 output size mismatch: manifest segments describe ${computed} bytes, header declares ${totalSize}.`);
  return {version,salt,totalSize,fileHash,dictionary,segments};
}

export async function decodeIc2Token(token) {
  const m=/^IC2\.([RZG])\.([A-Za-z0-9_-]+)$/.exec(String(token||''));
  if(!m)throw new Error('Not a valid IC2 token.');
  const packed=base64UrlToBytes(m[2]), binary=await decompressOuter(m[1],packed);
  return {manifest:decodeManifest(binary),binaryBytes:binary.length,packedBytes:packed.length,outerMode:m[1]};
}

function makeRecipeUnit(s) {
  if(s.kind===KIND.ZERO)return new Uint8Array(s.unitLen);
  if(s.kind===KIND.CONSTANT){const b=new Uint8Array(s.unitLen);b.fill(s.value);return b;}
  if(s.kind===KIND.REPEAT){const b=new Uint8Array(s.unitLen);for(let p=0;p<b.length;p+=s.pattern.length)b.set(s.pattern.subarray(0,Math.min(s.pattern.length,b.length-p)),p);return b;}
  if(s.kind===KIND.COUNTER8){const b=new Uint8Array(s.unitLen);for(let i=0;i<b.length;i++)b[i]=(s.start+i)&255;return b;}
  return null;
}
function referencedSet(segments){const set=new Set();for(const s of segments)if(s.kind===KIND.REF||s.kind===KIND.DELTA_XOR||s.kind===KIND.DELTA_SPLICE)set.add(s.base);return set;}

async function decodeUnit(s,index,cache,dictionary){
  let out=makeRecipeUnit(s);
  if(!out){
    if(s.kind===KIND.RAW)out=s.data.slice();
    else if(s.kind===KIND.COMPRESSED)out=await decompressByCodec(s.codec,s.data,s.unitLen);
    else if(s.kind===KIND.COMPRESSED_DICT)out=await decompressWithDictionary(s.data,dictionary,s.unitLen);
    else if(s.kind===KIND.REF){out=cache.get(s.base);if(!out)throw new Error(`Missing IC2 base segment ${s.base} for reference ${index}.`);out=out.slice();}
    else if(s.kind===KIND.DELTA_XOR){const base=cache.get(s.base);if(!base)throw new Error(`Missing IC2 base segment ${s.base} for delta ${index}.`);if(base.length!==s.unitLen)throw new Error('XOR delta base length mismatch.');const patch=await decompressByCodec(s.codec,s.data,s.unitLen);out=new Uint8Array(s.unitLen);for(let i=0;i<out.length;i++)out[i]=base[i]^patch[i];}
    else if(s.kind===KIND.DELTA_SPLICE){const base=cache.get(s.base);if(!base)throw new Error(`Missing IC2 base segment ${s.base} for delta ${index}.`);if(s.prefix+s.suffix>base.length||s.prefix+s.suffix>s.unitLen)throw new Error('Splice delta bounds are invalid.');const middleLen=s.unitLen-s.prefix-s.suffix;const mid=await decompressByCodec(s.codec,s.data,middleLen);out=new Uint8Array(s.unitLen);out.set(base.subarray(0,s.prefix),0);out.set(mid,s.prefix);if(s.suffix)out.set(base.subarray(base.length-s.suffix),s.unitLen-s.suffix);}
  }
  if(out.length!==s.unitLen)throw new Error(`IC2 segment ${index} produced wrong length.`);
  const h=sha256(out);if(!equalBytes(h,s.hash))throw new Error(`IC2 segment ${index} failed SHA-256 verification.`);
  return out;
}

async function writeRepeated(unit,count,sink,hasher,onBytes){
  const MAX_BLOCK=8*1024*1024, repsPerBlock=Math.max(1,Math.floor(MAX_BLOCK/unit.length)); let left=count;
  while(left>0){const reps=Math.min(left,repsPerBlock);let block;if(reps===1)block=unit;else{block=new Uint8Array(unit.length*reps);for(let p=0;p<block.length;p+=unit.length)block.set(unit,p);}hasher.update(block);await sink.write(block);onBytes(block.length);left-=reps;}
}

export async function decodeManifestToSink(manifest,sink,{onProgress=()=>{},signal=null}={}){
  const refs=referencedSet(manifest.segments),cache=new Map(),fileHasher=new Sha256(); let written=0;
  for(let i=0;i<manifest.segments.length;i++){
    cancelCheck(signal); const s=manifest.segments[i], unit=await decodeUnit(s,i,cache,manifest.dictionary);
    if(refs.has(i))cache.set(i,unit);
    await writeRepeated(unit,s.repeatCount,sink,fileHasher,n=>{written+=n;onProgress({segment:i+1,segments:manifest.segments.length,written,total:manifest.totalSize});});
  }
  if(written!==manifest.totalSize)throw new Error(`IC2 reconstructed ${written} bytes but expected ${manifest.totalSize}.`);
  const finalHash=fileHasher.digest();if(!equalBytes(finalHash,manifest.fileHash))throw new Error('IC2 final SHA-256 verification failed.');
  if(sink.close)await sink.close(); return {written,fileHash:finalHash};
}

export function summarizeManifest(manifest){
  const counts={},bytes={};
  for(const s of manifest.segments){const n=KIND_NAME[s.kind]||`kind ${s.kind}`;counts[n]=(counts[n]||0)+1;bytes[n]=(bytes[n]||0)+s.unitLen*s.repeatCount;}
  return {counts,bytes,segments:manifest.segments.length,totalSize:manifest.totalSize,dictionaryBytes:manifest.dictionary?.length||0,version:manifest.version};
}
