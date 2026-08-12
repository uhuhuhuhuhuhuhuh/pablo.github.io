const CACHE='infinite-corridor-ic21pub-20260812';
const CORE=['./','./index.html','./styles.css','./knowledge.css','./public-share.js','./ic2-knowledge.js','./ic2-worker.js','./ic2-core.js','./ic2-util.js','./compression.js','./ics-share-codec.js','./share-receiver.js','./s/','./s/index.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.origin!==location.origin)return;
  if(url.pathname.endsWith('/ic2-public-knowledge.json')){
    e.respondWith(fetch(new Request(e.request,{cache:'no-store'})));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r;})));
});
