import { sha256, hex } from './ic2-util.js';

const DB_NAME = 'infinite-corridor-knowledge';
const DB_VERSION = 1;
const SAMPLE_STORE = 'samples';
const PROFILE_STORE = 'profiles';
const MAX_PROFILE_SAMPLES = 96;
const SAMPLE_BYTES = 2048;
const DICTIONARY_BYTES = 16 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
        const s = db.createObjectStore(SAMPLE_STORE, { keyPath:'id' });
        s.createIndex('profile', 'profile', { unique:false });
        s.createIndex('lastSeen', 'lastSeen', { unique:false });
      }
      if (!db.objectStoreNames.contains(PROFILE_STORE)) db.createObjectStore(PROFILE_STORE, { keyPath:'profile' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function reqValue(req) { return new Promise((resolve,reject)=>{ req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); }
function txDone(tx) { return new Promise((resolve,reject)=>{ tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted.')); }); }

export function knowledgeProfile(fileOrName, mime='') {
  const name = typeof fileOrName === 'string' ? fileOrName : (fileOrName?.name || '');
  const type = mime || (typeof fileOrName === 'object' ? fileOrName?.type : '') || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12) : '';
  if (ext) return `ext:${ext}`;
  if (type) return `mime:${type.toLowerCase().slice(0,80)}`;
  return 'generic';
}

async function getProfileSamples(db, profile) {
  const tx = db.transaction(SAMPLE_STORE, 'readonly');
  const idx = tx.objectStore(SAMPLE_STORE).index('profile');
  const rows = await reqValue(idx.getAll(profile));
  return rows || [];
}

export async function getKnowledgeSnapshot(file) {
  if (!('indexedDB' in globalThis)) return { profile:knowledgeProfile(file), dictionary:new Uint8Array(), sampleCount:0, observedFiles:0, observedBytes:0 };
  const profile = knowledgeProfile(file);
  const db = await openDb();
  const samples = await getProfileSamples(db, profile);
  samples.sort((a,b)=>(b.hits||1)-(a.hits||1) || (b.lastSeen||0)-(a.lastSeen||0));
  const chosen=[]; let total=0;
  for (const row of samples) {
    const data = new Uint8Array(row.data);
    if (!data.length) continue;
    const take = Math.min(data.length, DICTIONARY_BYTES-total);
    if (take<=0) break;
    chosen.push(data.subarray(0,take)); total += take;
  }
  const dictionary = new Uint8Array(total); let at=0;
  for (const part of chosen) { dictionary.set(part,at); at+=part.length; }
  const tx = db.transaction(PROFILE_STORE,'readonly');
  const p = await reqValue(tx.objectStore(PROFILE_STORE).get(profile));
  db.close();
  return { profile, dictionary, sampleCount:samples.length, observedFiles:p?.files||0, observedBytes:p?.bytes||0 };
}

export async function learnSamples(file, samples=[], metrics={}) {
  if (!('indexedDB' in globalThis) || !samples.length) return;
  const profile=knowledgeProfile(file), db=await openDb(), now=Date.now();
  const existingRows=await getProfileSamples(db,profile);
  const existingMap=new Map(existingRows.map(r=>[r.id,r]));
  const ptx=db.transaction(PROFILE_STORE,'readonly');
  const existingProfile=await reqValue(ptx.objectStore(PROFILE_STORE).get(profile));

  const tx=db.transaction([SAMPLE_STORE,PROFILE_STORE],'readwrite');
  const done=txDone(tx), store=tx.objectStore(SAMPLE_STORE), pstore=tx.objectStore(PROFILE_STORE);
  pstore.put({ profile, files:(existingProfile?.files||0)+1, bytes:(existingProfile?.bytes||0)+(file?.size||metrics.fileBytes||0), lastSeen:now });
  for (const sample of samples.slice(0,24)) {
    let data = sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data||[]);
    if (!data.length) continue;
    data=data.slice(0,SAMPLE_BYTES);
    const h=sample.hash||hex(sha256(data));
    const id=`${profile}:${h}`, old=existingMap.get(id);
    store.put({ id, profile, hash:h, data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength), hits:(old?.hits||0)+1, lastSeen:now });
  }
  await done;

  const rows=await getProfileSamples(db,profile);
  if (rows.length>MAX_PROFILE_SAMPLES) {
    rows.sort((a,b)=>(a.hits||1)-(b.hits||1) || (a.lastSeen||0)-(b.lastSeen||0));
    const dtx=db.transaction(SAMPLE_STORE,'readwrite'), ddone=txDone(dtx), ds=dtx.objectStore(SAMPLE_STORE);
    for (const row of rows.slice(0,rows.length-MAX_PROFILE_SAMPLES)) ds.delete(row.id);
    await ddone;
  }
  db.close();
}

export async function clearKnowledge() {
  if (!('indexedDB' in globalThis)) return;
  await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(DB_NAME);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=resolve;});
}

export async function knowledgeSummary() {
  if (!('indexedDB' in globalThis)) return { profiles:0,samples:0,files:0,bytes:0 };
  const db=await openDb();
  const tx=db.transaction([SAMPLE_STORE,PROFILE_STORE],'readonly');
  const [samples,profiles]=await Promise.all([reqValue(tx.objectStore(SAMPLE_STORE).count()),reqValue(tx.objectStore(PROFILE_STORE).getAll())]);
  db.close();
  return { profiles:profiles.length, samples, files:profiles.reduce((a,p)=>a+(p.files||0),0), bytes:profiles.reduce((a,p)=>a+(p.bytes||0),0) };
}

export async function trainBlob(blob, {name='training.txt', type='text/plain'}={}) {
  const fileLike={name,type,size:blob.size};
  const samples=[];
  const step=Math.max(4096,Math.floor(blob.size/24));
  for(let offset=0; offset<blob.size && samples.length<24; offset+=step){
    const start=Math.min(offset,Math.max(0,blob.size-SAMPLE_BYTES));
    const data=new Uint8Array(await blob.slice(start,start+SAMPLE_BYTES).arrayBuffer());
    if(data.length<256)continue;
    samples.push({data,hash:hex(sha256(data))});
  }
  await learnSamples(fileLike,samples,{fileBytes:blob.size});
  return {profile:knowledgeProfile(fileLike),samples:samples.length,bytes:blob.size};
}

export async function trainFromArchiveOrg({items=8,onProgress=()=>{}}={}) {
  const query='collection:gutenberg AND mediatype:texts';
  const page=1+Math.floor(Math.random()*40);
  const searchUrl=`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl%5B%5D=identifier&fl%5B%5D=title&rows=${Math.max(items*3,20)}&page=${page}&output=json`;
  const search=await fetch(searchUrl,{mode:'cors'});
  if(!search.ok)throw new Error(`Archive.org search failed with HTTP ${search.status}.`);
  const result=await search.json();
  const docs=result?.response?.docs||[];
  let trained=0,totalBytes=0;
  for(const doc of docs){
    if(trained>=items)break;
    try{
      onProgress({phase:'metadata',trained,target:items,title:doc.title||doc.identifier});
      const mr=await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,{mode:'cors'});
      if(!mr.ok)continue;
      const meta=await mr.json();
      const candidates=(meta.files||[]).filter(f=>{
        const n=String(f.name||'').toLowerCase(), size=Number(f.size||0);
        return size>=8192 && size<=2*1024*1024 && (n.endsWith('_djvu.txt') || n.endsWith('.txt'));
      }).sort((a,b)=>Number(a.size||0)-Number(b.size||0));
      const f=candidates[0]; if(!f)continue;
      const url=`https://archive.org/download/${encodeURIComponent(doc.identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`;
      onProgress({phase:'download',trained,target:items,title:doc.title||doc.identifier,size:Number(f.size||0)});
      const fr=await fetch(url,{mode:'cors'}); if(!fr.ok)continue;
      const blob=await fr.blob(); if(blob.size>2*1024*1024)continue;
      await trainBlob(blob,{name:f.name,type:'text/plain'});
      trained++; totalBytes+=blob.size;
      onProgress({phase:'learned',trained,target:items,title:doc.title||doc.identifier,size:blob.size});
    }catch(error){ console.warn('Archive.org training item skipped',doc.identifier,error); }
  }
  if(!trained)throw new Error('Archive.org returned no usable training files. Cross-origin access may be blocked in this browser, or the sampled items had no small text derivative.');
  return {trained,totalBytes,page};
}
