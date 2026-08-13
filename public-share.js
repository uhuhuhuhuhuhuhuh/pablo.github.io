import { formatBytes, inferMime, cleanFilename } from './ic2-util.js';
import { getKnowledgeSnapshot, learnSamples, knowledgeSummary, clearKnowledge, trainFromArchiveOrg } from './ic2-knowledge.js';

const $=s=>document.querySelector(s);
const fileInput=$('#file-input'),dropZone=$('#drop-zone'),addMore=$('#add-more'),clearQueue=$('#clear-queue');
const batchShell=$('#batch-shell'),fileQueue=$('#file-queue'),batchCount=$('#batch-count');
const createLinks=$('#create-links'),cancelBatch=$('#cancel-batch'),overallWrap=$('#overall-progress-wrap');
const overallProgress=$('#overall-progress'),overallStatus=$('#overall-status'),overallPercent=$('#overall-percent');
const outputsPanel=$('#outputs-panel'),outputsList=$('#outputs-list'),copyAll=$('#copy-all');
const queueTemplate=$('#queue-row-template'),outputTemplate=$('#output-row-template');
const knowledgeStatus=$('#knowledge-status'),archiveButton=$('#train-archive'),clearKnowledgeButton=$('#clear-knowledge');

let queue=[],nextId=1,currentWorker=null,currentItem=null,batchRunning=false,cancelRequested=false;
function extension(name){const p=String(name).split('.');return p.length>1?(p.pop().replace(/[^a-z0-9]/gi,'').slice(0,5).toUpperCase()||'FILE'):'FILE';}
function buildShareUrl(token,filename){const u=new URL('./s/',location.href);u.hash=`${token}/${encodeURIComponent(cleanFilename(filename))}`;return u.toString();}
function escapeHtml(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));}

async function refreshKnowledgeStatus(extra=''){
  try{const s=await knowledgeSummary();const local=`PRIVATE MEMORY ${s.samples.toLocaleString()} samples · ${s.profiles.toLocaleString()} profiles · ${s.files.toLocaleString()} files · ${formatBytes(s.bytes)} observed.`;const pub=s.publicProfiles?` PUBLIC BASELINE ${s.publicProfiles.toLocaleString()} profiles · ${s.publicFiles.toLocaleString()} files · ${formatBytes(s.publicBytes)} observed.`:'';knowledgeStatus.textContent=local+pub+(extra?` ${extra}`:'');}
  catch{knowledgeStatus.textContent='CORRIDOR MEMORY UNAVAILABLE IN THIS BROWSER.';}
}

function representationHtml(stats){
  const entries=Object.entries(stats?.byKind||{}).sort((a,b)=>b[1]-a[1]);if(!entries.length)return '';
  const rows=entries.map(([name,bytes])=>`<div class="rep-row"><span>${escapeHtml(name)}</span><strong>${formatBytes(bytes)}</strong></div>`).join('');
  const k=stats?.knowledge||{},c=stats?.corpus||{};
  const learned=k.dictionaryUsed?`<div class="knowledge-gain">ADAPTIVE MEMORY USED · ${Number(k.dictionaryUses||0).toLocaleString()} DICTIONARY CHUNKS · NET ${formatBytes(k.dictionarySavings||0)} SAVED</div>`:k.availableDictionaryBytes?`<div class="knowledge-gain muted">ADAPTIVE MEMORY TESTED · ORDINARY REPRESENTATION REMAINED SMALLER.</div>`:'';
  const corpus=c.matchedChunks?`<div class="knowledge-gain">CORPUS MATCH · ${Number(c.matchedChunks||0).toLocaleString()} CHUNKS · ${formatBytes(c.matchedBytes||0)} REFERENCED · ${Number(c.distinctSources||0).toLocaleString()} PUBLIC SOURCES</div>`:'';
  return `<div class="rep-grid">${rows}</div>${corpus}${learned}<div class="rep-foot">${Number(stats.chunks||0).toLocaleString()} CHUNKS → ${Number(stats.segments||0).toLocaleString()} SEGMENTS · ${formatBytes(stats.embeddedBytes||0)} EMBEDDED</div>`;
}
function stateLabel(item){if(item.status==='running')return['ENCODING','state-running'];if(item.status==='success')return['RECOVERED','state-success'];if(item.status==='error')return['FAILED','state-error'];return['WAITING','state-waiting'];}

function renderQueue(){
  fileQueue.textContent='';
  for(const item of queue){
    const frag=queueTemplate.content.cloneNode(true),row=frag.querySelector('.queue-row');row.dataset.id=item.id;row.classList.toggle('is-running',item.status==='running');row.classList.toggle('is-success',item.status==='success');row.classList.toggle('is-error',item.status==='error');
    row.querySelector('.queue-icon').textContent=extension(item.file.name);row.querySelector('.queue-name').textContent=item.file.name;row.querySelector('.queue-meta').textContent=`${formatBytes(item.file.size)} · ${item.file.type||inferMime(item.file.name)}`;
    const [label,cls]=stateLabel(item),state=row.querySelector('.queue-state');state.textContent=label;state.className=`queue-state ${cls}`;row.querySelector('.queue-message').textContent=item.message||'Awaiting initiation.';
    const pw=row.querySelector('.queue-progress-wrap'),p=row.querySelector('.queue-progress'),pt=row.querySelector('.queue-progress-text');if(item.status==='running'||item.progress>0){pw.hidden=false;p.value=item.progress||0;pt.textContent=`${Math.round((item.progress||0)*100)}%`;}
    const details=row.querySelector('.queue-details');if(item.details){details.innerHTML=item.details;details.hidden=false;}
    const retry=row.querySelector('.retry-file');retry.hidden=item.status!=='error'||batchRunning;retry.addEventListener('click',()=>retryItem(item.id));const remove=row.querySelector('.remove-file');remove.disabled=batchRunning&&item===currentItem;remove.addEventListener('click',()=>removeItem(item.id));fileQueue.appendChild(frag);
  }
  batchShell.hidden=!queue.length;dropZone.hidden=!!queue.length;batchCount.textContent=`${queue.length.toLocaleString()} object${queue.length===1?'':'s'}`;clearQueue.disabled=batchRunning||!queue.length;createLinks.disabled=batchRunning||!queue.some(x=>x.status!=='success');renderOutputs();updateOverall();
}
function renderOutputs(){
  const success=queue.filter(x=>x.status==='success'&&x.url);outputsPanel.hidden=!success.length;copyAll.disabled=!success.length;outputsList.textContent='';
  for(const item of success){const frag=outputTemplate.content.cloneNode(true);frag.querySelector('.output-name').textContent=item.file.name;frag.querySelector('.output-summary').textContent=item.summary||'Exact share recovered.';const input=frag.querySelector('.output-link');input.value=item.url;const copy=frag.querySelector('.copy-one');copy.addEventListener('click',()=>copyText(item.url,copy));frag.querySelector('.open-one').addEventListener('click',()=>window.open(item.url,'_blank','noopener,noreferrer'));outputsList.appendChild(frag);}
}
function updateOverall(){
  if(!queue.length){overallWrap.hidden=true;return;}const complete=queue.filter(x=>x.status==='success'||x.status==='error').length,running=queue.find(x=>x.status==='running');let value=complete/queue.length;if(running)value=(complete+(running.progress||0))/queue.length;overallProgress.value=Math.min(1,value);overallPercent.textContent=`${Math.round(value*100)}%`;
  if(batchRunning)overallStatus.textContent=running?`Traversing ${running.file.name}`:'Preparing next object…';else{const ok=queue.filter(x=>x.status==='success').length,fail=queue.filter(x=>x.status==='error').length;overallStatus.textContent=ok||fail?`${ok} recovered · ${fail} failed · ${queue.length-ok-fail} waiting`:'Awaiting initiation.';}overallWrap.hidden=!(batchRunning||complete);
}
function addFiles(files){for(const file of Array.from(files||[])){if(!(file instanceof File))continue;queue.push({id:nextId++,file,status:'waiting',progress:0,message:'Awaiting initiation.',url:'',summary:'',details:'',knowledge:null});}renderQueue();}
function removeItem(id){if(batchRunning&&currentItem?.id===id)return;queue=queue.filter(x=>x.id!==id);renderQueue();}
function clearAll(){if(batchRunning)return;queue=[];fileInput.value='';renderQueue();}
function retryItem(id){const item=queue.find(x=>x.id===id);if(!item||batchRunning)return;Object.assign(item,{status:'waiting',progress:0,message:'Retry queued.',url:'',summary:'',details:''});renderQueue();runBatch([item]);}
async function loadKnowledge(item){if(item.knowledge)return item.knowledge;try{item.knowledge=await getKnowledgeSnapshot(item.file);return item.knowledge;}catch{return null;}}

function encodeOne(item){return new Promise(async(resolve,reject)=>{
  currentItem=item;item.status='running';item.progress=0;item.message='Opening exact-match corridor…';item.details='';renderQueue();const knowledge=await loadKnowledge(item);if(cancelRequested){reject(Object.assign(new Error('Batch cancelled.'),{cancelled:true}));return;}
  const worker=new Worker('./ic2-worker.js?v=20260812corridor2',{type:'module'});currentWorker=worker;
  worker.onmessage=async event=>{const m=event.data||{};if(m.type==='progress'){if(m.total&&m.done>=0)item.progress=Math.min(1,m.done/m.total);if(m.phase==='corpus')item.message=`Scanning public corpus · ${Number(m.segments||0).toLocaleString()} segments resolved`;else if(m.phase==='fallback')item.message='Corpus path insufficient. Entering self-contained IC2 fallback…';else if(m.phase==='pack')item.message=`Sealing ${Number(m.segments||0).toLocaleString()} optimized segments…`;else item.message=`Analyzing locally · ${Number(m.segments||0).toLocaleString()} segments`;renderQueue();return;}
    if(m.type==='error'){worker.terminate();currentWorker=null;reject(new Error(m.message||'Encoder worker failed.'));return;}
    if(m.type==='done'){try{await learnSamples(item.file,m.learningSamples||[],{fileBytes:item.file.size});}catch(error){console.warn('IC2 knowledge update failed',error);}const url=buildShareUrl(m.token,item.file.name),outer=m.outerMode==='Z'?'Zstandard':m.outerMode==='G'?'gzip':'raw',label=m.format==='IC2C'?'IC2C corpus-assisted':'IC2 self-contained';item.url=url;item.summary=`${label} · ${url.length.toLocaleString()} URL chars · ${formatBytes(m.packedBytes)} packed · ${outer}`;item.details=representationHtml(m.stats);item.progress=1;item.status='success';item.message=m.format==='IC2C'?'Recovered through verified public corpus references.':'Recovered as a self-contained exact descriptor.';worker.terminate();currentWorker=null;item.knowledge=null;resolve(item);}
  };
  worker.onerror=e=>{worker.terminate();currentWorker=null;reject(new Error(e.message||'The IC2 worker failed.'));};worker.postMessage({type:'encode',file:item.file,knowledge});
});}

async function runBatch(explicitItems=null){
  if(batchRunning)return;const targets=explicitItems||queue.filter(x=>x.status!=='success');if(!targets.length)return;batchRunning=true;cancelRequested=false;cancelBatch.hidden=false;addMore.disabled=true;clearQueue.disabled=true;overallWrap.hidden=false;renderQueue();
  for(const item of targets){if(cancelRequested)break;if(item.status==='success')continue;try{await encodeOne(item);}catch(error){if(error?.cancelled||cancelRequested){item.status='waiting';item.progress=0;item.message='Traversal interrupted.';}else{item.status='error';item.progress=0;item.message=error?.message||String(error);}}currentItem=null;renderQueue();}
  batchRunning=false;currentWorker=null;currentItem=null;cancelBatch.hidden=true;addMore.disabled=false;cancelRequested=false;renderQueue();await refreshKnowledgeStatus();if(queue.some(x=>x.status==='success'))outputsPanel.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function cancelCurrent(){if(!batchRunning)return;cancelRequested=true;if(currentWorker){try{currentWorker.postMessage({type:'cancel'});}catch{}currentWorker.terminate();currentWorker=null;}if(currentItem){currentItem.status='waiting';currentItem.progress=0;currentItem.message='Traversal interrupted.';}batchRunning=false;currentItem=null;cancelBatch.hidden=true;addMore.disabled=false;renderQueue();}
async function copyText(text,button){try{await navigator.clipboard.writeText(text);}catch{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}if(button){const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,900);}}
async function copyAllLinks(){const rows=queue.filter(x=>x.status==='success'&&x.url).map(x=>`${x.file.name}\n${x.url}`);if(rows.length)await copyText(rows.join('\n\n'),copyAll);}

async function trainArchive(){if(batchRunning)return;archiveButton.disabled=true;clearKnowledgeButton.disabled=true;try{knowledgeStatus.textContent='CONTACTING ARCHIVE.ORG PUBLIC-DOMAIN CORPUS…';const result=await trainFromArchiveOrg({items:8,onProgress:p=>{if(p.phase==='download')knowledgeStatus.textContent=`MEMORY FEED ${p.trained+1}/${p.target} · DOWNLOADING ${p.title||'OBJECT'}${p.size?` · ${formatBytes(p.size)}`:''}`;else if(p.phase==='learned')knowledgeStatus.textContent=`MEMORY FEED ${p.trained}/${p.target} · LEARNED ${formatBytes(p.size)} LATEST`;else knowledgeStatus.textContent=`MEMORY FEED · INSPECTING ${p.title||'PUBLIC OBJECT'}`;}});queue.forEach(x=>x.knowledge=null);await refreshKnowledgeStatus(`ARCHIVE FEED ADDED ${result.trained} FILES · ${formatBytes(result.totalBytes)}.`);}catch(error){knowledgeStatus.textContent=`ARCHIVE FEED FAILED · ${error?.message||String(error)}`;}finally{archiveButton.disabled=false;clearKnowledgeButton.disabled=false;}}

dropZone.addEventListener('click',()=>fileInput.click());addMore.addEventListener('click',()=>{if(!batchRunning)fileInput.click();});dropZone.addEventListener('dragover',e=>{e.preventDefault();if(!batchRunning)dropZone.classList.add('dragging');});dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragging'));dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragging');if(!batchRunning)addFiles(e.dataTransfer?.files);});fileInput.addEventListener('change',()=>{if(!batchRunning)addFiles(fileInput.files);fileInput.value='';});clearQueue.addEventListener('click',clearAll);createLinks.addEventListener('click',()=>runBatch());cancelBatch.addEventListener('click',cancelCurrent);copyAll.addEventListener('click',copyAllLinks);archiveButton.addEventListener('click',trainArchive);clearKnowledgeButton.addEventListener('click',async()=>{if(batchRunning)return;clearKnowledgeButton.disabled=true;try{await clearKnowledge();queue.forEach(x=>x.knowledge=null);await refreshKnowledgeStatus('PRIVATE MEMORY ERASED. PUBLIC BASELINE UNCHANGED.');}finally{clearKnowledgeButton.disabled=false;}});
renderQueue();refreshKnowledgeStatus();if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js?v=20260812corridor2').catch(()=>{});