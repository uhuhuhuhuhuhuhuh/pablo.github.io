import { encodeFileToIc2 } from './ic2-core.js';
let signal={cancelled:false};
self.onmessage=async(event)=>{
  const msg=event.data||{};
  if(msg.type==='cancel'){signal.cancelled=true;return;}
  if(msg.type!=='encode')return;
  signal={cancelled:false};
  try{
    const result=await encodeFileToIc2(msg.file,{knowledge:msg.knowledge||null,signal,onProgress:p=>self.postMessage({type:'progress',...p})});
    self.postMessage({
      type:'done',token:result.token,binaryBytes:result.binaryBytes,packedBytes:result.packedBytes,
      outerMode:result.outerMode,stats:result.stats,learningSamples:result.learningSamples
    });
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error),code:error?.code||''});}
};
