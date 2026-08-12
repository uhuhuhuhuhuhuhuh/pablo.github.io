import { formatBytes, inferMime, cleanFilename, MAX_TOKEN_CHARS } from './ic2-util.js';
import { getKnowledgeSnapshot, learnSamples, knowledgeSummary, clearKnowledge, trainFromArchiveOrg } from './ic2-knowledge.js';

const $=s=>document.querySelector(s);
const fileInput=$('#file-input'),dropZone=$('#drop-zone'),fileCard=$('#file-card'),clearButton=$('#clear-file');
const createButton=$('#create-link'),cancelButton=$('#cancel-encode'),status=$('#status'),resultBox=$('#share-result');
const shareLink=$('#share-link'),copyButton=$('#copy-link'),openButton=$('#open-link'),newLinkButton=$('#new-link');
const progress=$('#encode-progress'),progressText=$('#progress-text'),details=$('#representation-details');
const knowledgeStatus=$('#knowledge-status'),archiveButton=$('#train-archive'),clearKnowledgeButton=$('#clear-knowledge');
let selectedFile=null,currentUrl='',worker=null,busy=false,currentKnowledge=null;

function extension(name){const p=String(name).split('.');return p.length>1?(p.pop().replace(/[^a-z0-9]/gi,'').slice(0,5).toUpperCase()||'FILE'):'FILE';}
function buildShareUrl(token,filename){const u=new URL('./s/',location.href);u.hash=`${token}/${encodeURIComponent(cleanFilename(filename))}`;return u.toString();}
function setBusy(v){busy=v;createButton.disabled=v||!selectedFile;clearButton.disabled=v;dropZone.disabled=v;cancelButton.hidden=!v;progress.hidden=!v;createButton.textContent=v?'Encoding…':'Create share link';}
function resetProgress(){progress.value=0;progressText.textContent='';}

async function refreshKnowledgeStatus(extra=''){
  try{
    const s=await knowledgeSummary();
    const local=`Private browser knowledge: ${s.samples.toLocaleString()} samples across ${s.profiles.toLocaleString()} profiles from ${s.files.toLocaleString()} analyzed files (${formatBytes(s.bytes)} observed).`;
    const pub=s.publicProfiles?` Public baseline: ${s.publicProfiles.toLocaleString()} profiles trained from ${s.publicFiles.toLocaleString()} public files (${formatBytes(s.publicBytes)} observed).`:'';
    knowledgeStatus.textContent=local+pub+(extra?' '+extra:'');
  }catch{knowledgeStatus.textContent='Adaptive knowledge is unavailable in this browser.';}
}

async function loadKnowledgeForSelected(){
  if(!selectedFile){currentKnowledge=null;return;}
  try{
    currentKnowledge=await getKnowledgeSnapshot(selectedFile);
    const k=currentKnowledge;
    if(k.dictionary.length){
      const parts=[];
      if(k.localDictionaryBytes)parts.push(`${formatBytes(k.localDictionaryBytes)} private/local`);
      if(k.publicDictionaryBytes)parts.push(`${formatBytes(k.publicDictionaryBytes)} public baseline`);
      status.textContent=`IC2 found ${formatBytes(k.dictionary.length)} of adaptive dictionary material for this file profile${parts.length?` (${parts.join(' + ')})`:''}. Exact public-corpus chunk matching will also be tried if a corpus catalog is installed.`;
    }
  }catch{currentKnowledge=null;}
}

function showFile(file){
  selectedFile=file;currentUrl='';resultBox.hidden=true;shareLink.value='';
  $('#file-name').textContent=file.name;$('#file-size').textContent=formatBytes(file.size);$('#file-type').textContent=file.type||inferMime(file.name);$('#file-ext').textContent=extension(file.name);
  dropZone.hidden=true;fileCard.hidden=false;clearButton.hidden=false;createButton.disabled=false;details.hidden=true;
  status.textContent=`No fixed source-file cap. The encoder first checks exact public-corpus chunks. If useful matches exist it can create a corpus-assisted IC2C share; otherwise it falls back to exact self-contained IC2. The final public token is limited to ${MAX_TOKEN_CHARS.toLocaleString()} characters.`;
  resetProgress();loadKnowledgeForSelected();
}
function clearFile(){if(busy)return;selectedFile=null;currentKnowledge=null;currentUrl='';fileInput.value='';fileCard.hidden=true;dropZone.hidden=false;clearButton.hidden=true;createButton.disabled=true;resultBox.hidden=true;shareLink.value='';details.hidden=true;status.textContent='Choose a file to begin.';resetProgress();}

function representationHtml(stats){
  const entries=Object.entries(stats?.byKind||{}).sort((a,b)=>b[1]-a[1]);
  if(!entries.length)return '';
  const rows=entries.map(([name,bytes])=>`<div class="rep-row"><span>${name}</span><strong>${formatBytes(bytes)}</strong></div>`).join('');
  const k=stats?.knowledge||{};
  const learned=k.dictionaryUsed
    ? `<div class="knowledge-gain">Adaptive knowledge used · ${k.dictionaryUses.toLocaleString()} dictionary chunks · net descriptor saving ${formatBytes(k.dictionarySavings)}</div>`
    : k.availableDictionaryBytes?`<div class="knowledge-gain muted">Available knowledge was tested but did not beat the self-contained alternatives after dictionary overhead.</div>`:'';
  const c=stats?.corpus||{};
  const corpus=c.matchedChunks
    ? `<div class="knowledge-gain">Public corpus exact matches · ${c.matchedChunks.toLocaleString()} chunks · ${formatBytes(c.matchedBytes)} represented by verified public byte-range references · ${c.distinctSources.toLocaleString()} source object${c.distinctSources===1?'':'s'}</div>`
    : '';
  return `<div class="rep-grid">${rows}</div>${corpus}${learned}<div class="rep-foot">${stats.chunks.toLocaleString()} chunks → ${stats.segments.toLocaleString()} manifest segments · ${formatBytes(stats.embeddedBytes)} embedded payload</div>`;
}

async function createShare(){
  if(!selectedFile||busy)return;
  if(worker)worker.terminate();
  if(!currentKnowledge)await loadKnowledgeForSelected();
  worker=new Worker('./ic2-worker.js?v=20260812ic2c1',{type:'module'});setBusy(true);resultBox.hidden=true;details.hidden=true;resetProgress();
  status.textContent='Starting exact public-corpus matching, with self-contained IC2 fallback…';
  worker.onmessage=async(event)=>{
    const m=event.data||{};
    if(m.type==='progress'){
      if(m.total&&m.done>=0){progress.value=Math.min(1,m.done/m.total);progressText.textContent=`${Math.round(progress.value*100)}% · ${formatBytes(m.done)} / ${formatBytes(m.total)}`;}
      if(m.phase==='corpus')status.textContent=`Matching exact public corpus chunks · ${m.segments.toLocaleString()} segments so far…`;
      else if(m.phase==='fallback')status.textContent='No sufficiently useful corpus-assisted descriptor was produced. Retrying with exact self-contained IC2…';
      else if(m.phase==='pack')status.textContent=`Packing ${m.segments.toLocaleString()} optimized segments…`;
      else status.textContent=`Analyzing locally · ${m.segments.toLocaleString()} segments so far`;
      return;
    }
    if(m.type==='error'){currentUrl='';resultBox.hidden=true;status.textContent=m.message;setBusy(false);worker?.terminate();worker=null;return;}
    if(m.type==='done'){
      try{await learnSamples(selectedFile,m.learningSamples||[],{fileBytes:selectedFile.size});}catch(error){console.warn('IC2 knowledge update failed',error);}
      const url=buildShareUrl(m.token,selectedFile.name);currentUrl=url;shareLink.value=url;
      const mode=m.outerMode==='Z'?'Zstandard':m.outerMode==='G'?'gzip':'raw';
      const label=m.format==='IC2C'?'IC2C corpus-assisted':'IC2 self-contained';
      $('#share-summary').textContent=`${label} · ${url.length.toLocaleString()} URL characters · ${formatBytes(m.packedBytes)} packed manifest · outer ${mode}`;
      details.innerHTML=representationHtml(m.stats);details.hidden=false;resultBox.hidden=false;
      status.textContent=m.format==='IC2C'
        ? 'Ready to share. Exact referenced chunks will be fetched from the embedded public source URLs and SHA-256 verified by the receiver.'
        : 'Ready to share. This share is self-contained; useful structural samples were retained privately in this browser.';
      progress.value=1;progressText.textContent='100%';setBusy(false);worker?.terminate();worker=null;currentKnowledge=null;await refreshKnowledgeStatus();
      resultBox.scrollIntoView({behavior:'smooth',block:'nearest'});return;
    }
  };
  worker.onerror=e=>{status.textContent=e.message||'The IC2 worker failed.';setBusy(false);worker?.terminate();worker=null;};
  worker.postMessage({type:'encode',file:selectedFile,knowledge:currentKnowledge});
}

async function trainArchive(){
  if(busy)return;
  archiveButton.disabled=true;clearKnowledgeButton.disabled=true;
  try{
    knowledgeStatus.textContent='Connecting to Archive.org public-domain text corpus…';
    const result=await trainFromArchiveOrg({items:8,onProgress:p=>{
      if(p.phase==='download')knowledgeStatus.textContent=`Archive.org training ${p.trained+1}/${p.target}: downloading ${p.title||'item'}${p.size?` (${formatBytes(p.size)})`:''}…`;
      else if(p.phase==='learned')knowledgeStatus.textContent=`Archive.org training: learned from ${p.trained}/${p.target} files (${formatBytes(p.size)} latest).`;
      else knowledgeStatus.textContent=`Archive.org training: inspecting ${p.title||'public-domain item'}…`;
    }});
    await refreshKnowledgeStatus(`Archive.org run added ${result.trained} private/local training files totaling ${formatBytes(result.totalBytes)}.`);
    currentKnowledge=null;if(selectedFile)await loadKnowledgeForSelected();
  }catch(error){knowledgeStatus.textContent=`Archive.org training could not complete: ${error?.message||String(error)}`;}
  finally{archiveButton.disabled=false;clearKnowledgeButton.disabled=false;}
}

async function copyCurrentLink(){if(!currentUrl)return;try{await navigator.clipboard.writeText(currentUrl);}catch{shareLink.focus();shareLink.select();document.execCommand('copy');}const old=copyButton.textContent;copyButton.textContent='Copied';setTimeout(()=>copyButton.textContent=old,1000);}

dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('dragover',e=>{e.preventDefault();if(!busy)dropZone.classList.add('dragging');});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragging');if(busy)return;const f=e.dataTransfer?.files?.[0];if(f)showFile(f);});
fileInput.addEventListener('change',()=>{const f=fileInput.files?.[0];if(f)showFile(f);});clearButton.addEventListener('click',clearFile);createButton.addEventListener('click',createShare);
cancelButton.addEventListener('click',()=>{if(worker){worker.postMessage({type:'cancel'});worker.terminate();worker=null;}setBusy(false);status.textContent='Encoding cancelled.';});
copyButton.addEventListener('click',copyCurrentLink);openButton.addEventListener('click',()=>currentUrl&&window.open(currentUrl,'_blank','noopener,noreferrer'));newLinkButton.addEventListener('click',createShare);
archiveButton.addEventListener('click',trainArchive);
clearKnowledgeButton.addEventListener('click',async()=>{if(busy)return;clearKnowledgeButton.disabled=true;try{await clearKnowledge();currentKnowledge=null;await refreshKnowledgeStatus('Private browser learning was cleared; the repository public baseline was not changed.');if(selectedFile)await loadKnowledgeForSelected();}finally{clearKnowledgeButton.disabled=false;}});
refreshKnowledgeStatus();
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js?v=20260812ic2c1').catch(()=>{});
