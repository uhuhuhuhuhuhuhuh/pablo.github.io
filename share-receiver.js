import { decodeIc2Token, decodeManifestToSink, summarizeManifest } from './ic2-core.js';
import { decodeIc2CorpusToken, decodeIc2CorpusToSink, summarizeIc2Corpus } from './ic2-corpus-share.js';
import { decodeIcsToken } from './ics-share-codec.js';
import { cleanFilename, formatBytes, inferMime } from './ic2-util.js';

const $=s=>document.querySelector(s);
const nameEl=$('#download-name'),metaEl=$('#download-meta'),statusEl=$('#download-status'),button=$('#download-button'),extEl=$('#download-ext');
const progress=$('#download-progress'),progressText=$('#download-progress-text'),details=$('#download-details');
let parsed=null,decodedIc2=null,decodedCorpus=null,busy=false,objectUrl=null;
const plural=(n,word)=>`${n.toLocaleString()} ${word}${n===1?'':'s'}`;
function extension(name){const p=String(name).split('.');return p.length>1?(p.pop().replace(/[^a-z0-9]/gi,'').slice(0,5).toUpperCase()||'FILE'):'FILE';}
function parseShare(){const raw=location.hash.replace(/^#/,'');if(!raw)throw new Error('This link does not contain a shared file.');const slash=raw.lastIndexOf('/');if(slash<0)throw new Error('This share link is missing its filename.');const token=raw.slice(0,slash);let name;try{name=decodeURIComponent(raw.slice(slash+1));}catch{throw new Error('The filename in this share link is malformed.');}return{token,name:cleanFilename(name)};}
function setBusy(v){busy=v;button.disabled=v;button.textContent=v?'Reconstructing…':`Download ${parsed?.name||'file'}`;progress.hidden=!v;}
function detailsHtml(summary){const rows=Object.entries(summary.bytes).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="rep-row"><span>${k}</span><strong>${formatBytes(v)}</strong></div>`).join('');const dict=summary.dictionaryBytes?`<div class="rep-row"><span>embedded learned dictionary</span><strong>${formatBytes(summary.dictionaryBytes)}</strong></div>`:'';const src=summary.sourceCount?`<div class="rep-row"><span>public corpus source objects</span><strong>${summary.sourceCount.toLocaleString()}</strong></div>`:'';return rows+dict+src+`<div class="rep-foot">${plural(summary.segments,'manifest segment')}</div>`;}
const IN_MEMORY_LIMIT=256*1024*1024;
function onProgress(p){progress.value=p.total?p.written/p.total:0;progressText.textContent=`${Math.round(progress.value*100)}% · ${formatBytes(p.written)} / ${formatBytes(p.total)}`;}
function triggerDownload(blob){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);const a=document.createElement('a');a.href=objectUrl;a.download=parsed.name;document.body.appendChild(a);a.click();a.remove();}
// OPFS temp files cannot be deleted while the browser may still be reading them for a download, so sweep ones older than an hour on a later visit instead.
async function sweepTempFiles(){try{const root=await navigator.storage?.getDirectory?.();if(!root)return;const cutoff=Date.now()-3600e3;for await(const name of root.keys()){const m=/^ic2-(\d+)-/.exec(name);if(m&&Number(m[1])<cutoff)await root.removeEntry(name).catch(()=>{});}}catch{}}
async function saveToHandle(handle,decode){const writable=await handle.createWritable();try{await decode({write:data=>writable.write(data),close:()=>writable.close()});}catch(error){try{await writable.abort();}catch{}throw error;}}

// fromGesture: showSaveFilePicker only works during a user click, so automatic
// starts decode small files in memory and hand them to a normal download.
async function saveWithManifest(manifest,decodeToSink,label,fromGesture){
  if(busy)return;setBusy(true);statusEl.className='download-status';statusEl.textContent=label;
  const decode=sink=>decodeToSink(manifest,sink,{onProgress});
  try{
    const small=manifest.totalSize<=IN_MEMORY_LIMIT;
    if(fromGesture&&'showSaveFilePicker' in window&&!small){
      const ext='.'+(parsed.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'');
      let handle;
      try{handle=await window.showSaveFilePicker({suggestedName:parsed.name,types:[{description:'Shared file',accept:{[inferMime(parsed.name)]:[ext]}}]});}
      catch(error){if(error?.name==='AbortError'){statusEl.textContent='Save cancelled. The manifest is still ready.';return;}throw error;}
      await saveToHandle(handle,decode);
    }else if(!small&&navigator.storage?.getDirectory){
      const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle(`ic2-${Date.now()}-${parsed.name}`,{create:true});
      await saveToHandle(handle,decode);triggerDownload(await handle.getFile());
    }else{
      if(!small)throw new Error('This browser does not expose a streaming file sink for an output this large. Use a Chromium-based browser with the File System Access API.');
      const parts=[];await decode({write:async data=>{parts.push(data.slice());},close:async()=>{}});
      triggerDownload(new Blob(parts,{type:inferMime(parsed.name)}));
    }
    statusEl.className='download-status success';statusEl.textContent='File reconstructed successfully. Every segment and the complete output passed SHA-256 verification.';
  }catch(error){statusEl.className='download-status error';statusEl.textContent=error?.message||String(error);}finally{setBusy(false);}
}

const saveIc2=fromGesture=>saveWithManifest(decodedIc2.manifest,decodeManifestToSink,'Reconstructing and verifying self-contained IC2 segments…',fromGesture);
const saveCorpus=fromGesture=>saveWithManifest(decodedCorpus.manifest,decodeIc2CorpusToSink,'Fetching verified public corpus byte ranges and reconstructing the file…',fromGesture);
async function saveLegacy(){if(busy)return;setBusy(true);try{const result=await decodeIcsToken(parsed.token);triggerDownload(new Blob([result.bytes],{type:inferMime(parsed.name)}));statusEl.className='download-status success';statusEl.textContent='Legacy ICS1 file reconstructed and SHA-256 verified.';}catch(error){statusEl.className='download-status error';statusEl.textContent=error?.message||String(error);}finally{setBusy(false);}}

async function load(){
  sweepTempFiles();parsed=parseShare();document.title=`${parsed.name} · The Infinite Corridor`;nameEl.textContent=parsed.name;extEl.textContent=extension(parsed.name);
  if(parsed.token.startsWith('IC2C.')){
    statusEl.textContent='Reading the corpus-assisted IC2C manifest locally…';decodedCorpus=await decodeIc2CorpusToken(parsed.token);const m=decodedCorpus.manifest;const summary=summarizeIc2Corpus(m);
    metaEl.textContent=`${formatBytes(m.totalSize)} · IC2C corpus-assisted · ${plural(summary.segments,'segment')} · ${summary.sourceCount.toLocaleString()} public source object${summary.sourceCount===1?'':'s'} · ${decodedCorpus.outerMode==='Z'?'Zstandard':decodedCorpus.outerMode==='G'?'gzip':'raw'} outer manifest`;
    details.innerHTML=detailsHtml(summary);details.hidden=false;statusEl.className='download-status success';statusEl.textContent='Manifest verified and ready. Reconstruction will contact the public source URLs embedded in this share, request exact byte ranges, and verify each returned chunk with SHA-256.';
    button.disabled=false;button.textContent=`Download ${parsed.name}`;button.onclick=()=>saveCorpus(true);if(m.totalSize<=16*1024*1024)setTimeout(()=>saveCorpus(false),500);
  }else if(parsed.token.startsWith('IC2.')){
    statusEl.textContent='Reading the IC2 manifest locally…';decodedIc2=await decodeIc2Token(parsed.token);const m=decodedIc2.manifest;const summary=summarizeManifest(m);const label=m.version>=3?'IC2.1':'IC2 v2';
    metaEl.textContent=`${formatBytes(m.totalSize)} · ${label} · ${plural(summary.segments,'segment')} · ${decodedIc2.outerMode==='Z'?'Zstandard':decodedIc2.outerMode==='G'?'gzip':'raw'} outer manifest`;details.innerHTML=detailsHtml(summary);details.hidden=false;statusEl.className='download-status success';statusEl.textContent=m.totalSize>1024**3?'Ready. This link reconstructs a very large output; saving will stream it to disk and can take substantial time.':'Manifest verified and ready for reconstruction.';button.disabled=false;button.textContent=`Download ${parsed.name}`;button.onclick=()=>saveIc2(true);if(m.totalSize<=16*1024*1024)setTimeout(()=>saveIc2(false),350);
  }else if(parsed.token.startsWith('ICS1.')){
    metaEl.textContent='Legacy ICS1 self-contained share';statusEl.textContent='Ready to reconstruct legacy share.';button.disabled=false;button.textContent=`Download ${parsed.name}`;button.onclick=saveLegacy;setTimeout(()=>saveLegacy(),350);
  }else throw new Error('This is not a supported Infinite Corridor share token.');
}
load().catch(error=>{statusEl.className='download-status error';statusEl.textContent=error?.message||String(error);button.disabled=true;button.textContent='Download unavailable';metaEl.textContent='This share could not be opened.';});
addEventListener('beforeunload',()=>objectUrl&&URL.revokeObjectURL(objectUrl));
if('serviceWorker' in navigator)navigator.serviceWorker.register('../sw.js').catch(()=>{});
