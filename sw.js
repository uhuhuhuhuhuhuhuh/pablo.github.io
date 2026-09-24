// Network-first: fresh deploys reach visitors immediately, and the cache only
// serves as an offline fallback. Bump CACHE when the CORE list changes.
const CACHE='infinite-corridor-20260924';
const CORE=['./','./index.html','./styles.css','./knowledge.css','./public-share.js','./ic2-knowledge.js','./ic2-worker.js','./ic2-core.js','./ic2-corpus.js','./ic2-corpus-share.js','./ic2-util.js','./compression.js','./ics-share-codec.js','./share-receiver.js','./s/','./s/index.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'||req.headers.has('range'))return;
  const url=new URL(req.url);
  if(url.origin!==location.origin)return;
  // Large, frequently regenerated data: never cache.
  if(url.pathname.endsWith('/ic2-public-knowledge.json')||url.pathname.includes('/corpus/'))return;
  e.respondWith((async()=>{
    try{
      const res=await fetch(req);
      if(res.ok&&res.type==='basic'){const copy=res.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{}));}
      return res;
    }catch(error){
      // Versioned URLs (?v=...) fall back to the unversioned precached copy.
      const hit=await caches.match(req)||await caches.match(req,{ignoreSearch:true});
      if(hit)return hit;
      throw error;
    }
  })());
});
