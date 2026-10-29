/* Public, UI-independent engine API. All executable code/models are packaged. */
(()=>{
  let processing,inference,active,nextId=1;
  const abortError=()=>new DOMException('处理已取消','AbortError');
  function terminate(){processing?.terminate();inference?.terminate();processing=inference=undefined;}
  function cancel(){const current=active;active=undefined;terminate();if(current){current.cleanup();current.reject(abortError());}}
  function ensure(){
    if(processing)return;
    if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('本机处理引擎需要 Chrome 扩展 COOP/COEP 跨源隔离设置。');
    processing=new Worker(chrome.runtime.getURL('engine-worker.js'));
    inference=new Worker(chrome.runtime.getURL('inference-worker.js'),{type:'module'});
    const processor=processing;
    processor.onmessage=({data})=>{
      if(processing!==processor)return;
      if(data.type==='infer'){inference.postMessage(data,[data.data]);return;}
      if(data.type==='progress'){active?.progress?.(data.message);return;}
      if(!active||data.id!==active.id)return;
      const current=active;active=undefined;current.cleanup();
      if(data.type==='result')current.resolve(data.result);
      else{
        if(data.error?.fatal)terminate();
        current.reject(Object.assign(new Error(data.error?.message||'本机引擎失败'),{code:data.error?.code}));
      }
    };
    const fail=event=>{
      if(processing!==processor)return;
      const current=active;active=undefined;terminate();
      if(current){current.cleanup();current.reject(new Error(event.message||'本机引擎工作线程停止'));}
    };
    processing.onerror=fail;inference.onerror=fail;
  }
  function execute(type,job,{signal,onProgress}={}){
    if(signal?.aborted)return Promise.reject(abortError());
    if(active)return Promise.reject(new Error('处理引擎正在运行，请先完成或取消当前任务。'));
    try{ensure();}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const id=nextId++;
      const cleanup=()=>signal?.removeEventListener('abort',cancel);
      active={id,resolve,reject,cleanup,progress:onProgress};
      signal?.addEventListener('abort',cancel,{once:true});
      // Clone the caller's buffers: the UI may still need the fetched originals.
      processing.postMessage(type==='diagnostic'?{type,id,bytes:job.bytes}:{type,id,job});
    });
  }
  globalThis.PluginEngine=Object.freeze({
    process:(job,options)=>execute('process',job,options),
    cancel,reset:cancel,
    diagnosticOCR:(bytes,options)=>execute('diagnostic',{bytes},options)
  });
})();
