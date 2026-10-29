/* Original Python image-processing engine, isolated from the UI. */
importScripts('vendor/pyodide/pyodide.js');
let runtimePromise;
let shared;
const HEADER_BYTES=4096;
const RESPONSE_BYTES=64*1024*1024;
self.engine_progress=(message)=>postMessage({type:'progress',message:String(message)});
self.engine_infer=(model,inputName,shapeJson,pythonBytes)=>{
  const source=pythonBytes.toJs();
  const data=new Uint8Array(source).slice();
  if(data.byteLength>64*1024*1024) throw new Error('OCR input exceeds the bounded inference buffer');
  shared ||= new SharedArrayBuffer(HEADER_BYTES+RESPONSE_BYTES);
  const state=new Int32Array(shared,0,3);
  Atomics.store(state,0,0);
  postMessage({type:'infer',model,inputName,dims:JSON.parse(shapeJson),data:data.buffer,shared},[data.buffer]);
  const status=Atomics.wait(state,0,0,180000);
  if(status==='timed-out') throw new Error('Local OCR inference timed out');
  const length=Atomics.load(state,1);
  if(length<1||length>HEADER_BYTES-16)throw new Error('Invalid OCR response header');
  const meta=JSON.parse(new TextDecoder().decode(new Uint8Array(shared,16,length).slice()));
  if(Atomics.load(state,0)!==1)throw new Error(meta.error||'Local OCR inference failed');
  const size=Atomics.load(state,2);
  if(size<0||size>RESPONSE_BYTES)throw new Error('OCR output exceeds the bounded inference buffer');
  return {shape:JSON.stringify(meta.dims),data:new Uint8Array(shared,HEADER_BYTES,size).slice()};
};
async function runtime(){
  if(!runtimePromise)runtimePromise=(async()=>{
    if(!self.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('本机引擎需要扩展跨源隔离（COOP/COEP）设置。');
    engine_progress('加载内置 Python / OpenCV 引擎…');
    const py=await loadPyodide({indexURL:new URL('vendor/pyodide/',self.location.href).href});
    await py.loadPackage(['numpy','pillow','opencv-python','pyclipper','shapely','pyyaml','requests','tqdm','packaging','ssl'],{messageCallback:m=>engine_progress('加载内置依赖：'+m)});
    const original=await (await fetch('engine/original.zip')).arrayBuffer();
    py.FS.mkdirTree('/engine');py.FS.mkdirTree('/job');
    py.unpackArchive(original,'zip',{extractDir:'/engine'});
    for(const name of ['models.json','onnxruntime.py','browser_adapter.py','brand-edge-templates.npz'])py.FS.writeFile('/engine/'+name,new Uint8Array(await (await fetch('engine/'+name)).arrayBuffer()));
    const models=await (await fetch('engine/models.json')).json();
    const modelDir='/engine/vendor/ocr/rapidocr/models';py.FS.mkdirTree(modelDir);
    // RapidOCR verifies local model paths. Inference bytes are owned by the ORT worker.
    for(const name of Object.keys(models))py.FS.writeFile(modelDir+'/'+name,new Uint8Array([0]));
    await py.runPythonAsync('import sys\nsys.path[:0] = ["/engine", "/engine/vendor/ocr"]\nimport browser_adapter');
    return py;
  })();
  return runtimePromise;
}
onmessage=async({data:message})=>{
  if(message.type!=='process'&&message.type!=='diagnostic')return;
  let py;
  const files=[];
  try{
    py=await runtime();
    if(message.type==='diagnostic'){
      files.push('/job/ocr.png');
      py.FS.writeFile('/job/ocr.png',new Uint8Array(message.bytes));
      const result=await py.runPythonAsync('browser_adapter.diagnostic_ocr("/job/ocr.png")');
      postMessage({type:'result',id:message.id,result:JSON.parse(result)});return;
    }
    if(!Array.isArray(message.job?.candidates)||message.job.candidates.length>20)throw new Error('处理图源数量不正确');
    let totalBytes=0;
    for(const candidate of message.job.candidates){
      if(!(candidate.bytes instanceof ArrayBuffer)||!candidate.bytes.byteLength||candidate.bytes.byteLength>32*1024*1024)throw new Error('单张图源字节大小不正确');
      totalBytes+=candidate.bytes.byteLength;
    }
    if(totalBytes>256*1024*1024)throw new Error('本次图源总大小超出处理上限');
    const candidates=message.job.candidates.map((v,i)=>{
      const path='/job/candidate-'+i+'.bin';files.push(path);py.FS.writeFile(path,new Uint8Array(v.bytes));
      return {url:v.url,path,via:v.via||'browser'};
    });
    files.push('/job/candidates.json','/job/extra-sources.json','/job/output.bin','/job/source.bin','/job/comparison.bin');
    py.FS.writeFile('/job/candidates.json',JSON.stringify(candidates));
    py.FS.writeFile('/job/extra-sources.json',JSON.stringify(message.job.extraSources||[]));
    py.globals.set('_input_url',message.job.inputUrl);py.globals.set('_allow_repair',message.job.allowRepair!==false);
    const result=JSON.parse(await py.runPythonAsync('browser_adapter.process(_input_url, _allow_repair)'));
    if(!result.ok)throw Object.assign(new Error(result.payload.error?.message||'原版处理引擎未能生成预览'),{code:result.payload.error?.code});
    // FS.readFile already allocates an independent byte array. Transfer that
    // buffer directly; retain an exact slice for any non-whole-buffer view.
    for(const [key,file] of [['output','output.bin'],['source','source.bin'],['comparison','comparison.bin']]){
      const bytes=py.FS.readFile('/job/'+file);
      result[key]=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes.slice().buffer;
    }
    postMessage({type:'result',id:message.id,result},[result.output,result.source,result.comparison]);
  }catch(error){postMessage({type:'error',id:message.id,error:{message:error.message,code:error.code||'ENGINE_FAILED',stack:error.stack,fatal:!py}});}
  finally{
    if(py)for(const path of files){try{py.FS.unlink(path);}catch{}}
  }
};
