import { encodeFileToIc2 } from './ic2-core.js';
import { encodeFileToIc2Corpus } from './ic2-corpus-share.js';
let signal={cancelled:false};
self.onmessage=async(event)=>{
  const msg=event.data||{};
  if(msg.type==='cancel'){signal.cancelled=true;return;}
  if(msg.type!=='encode')return;
  signal={cancelled:false};
  try{
    let result=null,corpusError=null;
    try{
      result=await encodeFileToIc2Corpus(msg.file,{signal,onProgress:p=>self.postMessage({type:'progress',...p})});
    }catch(error){
      corpusError=error;
      if(signal.cancelled)throw error;
      self.postMessage({type:'progress',phase:'fallback',done:0,total:msg.file?.size||0,segments:0,reason:error?.code||''});
    }
    if(!result){
      result=await encodeFileToIc2(msg.file,{knowledge:msg.knowledge||null,signal,onProgress:p=>self.postMessage({type:'progress',...p})});
      result.format='IC2';
      if(corpusError)result.corpusFallbackReason=corpusError?.code||corpusError?.message||'';
    }
    self.postMessage({
      type:'done',token:result.token,binaryBytes:result.binaryBytes,packedBytes:result.packedBytes,
      outerMode:result.outerMode,stats:result.stats,learningSamples:result.learningSamples||[],
      format:result.format||'IC2',corpusFallbackReason:result.corpusFallbackReason||''
    });
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error),code:error?.code||''});}
};
