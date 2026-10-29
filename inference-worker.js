/* Local ONNX Runtime Web backend for the unmodified RapidOCR models. */
import * as ort from './vendor/ort/ort.wasm.min.mjs';
ort.env.wasm.wasmPaths=new URL('./vendor/ort/',import.meta.url).href;
ort.env.wasm.numThreads=Math.max(1,Math.min(3,navigator.hardwareConcurrency||1));
ort.env.wasm.proxy=false;
const sessions=new Map();
const HEADER_BYTES=4096;
async function infer(request){
  const state=new Int32Array(request.shared,0,3);
  try{
    if(!/^PP-OCRv6_(det|rec)_small\.onnx$/.test(request.model))throw new Error('Unrecognized bundled OCR model');
    if(!sessions.has(request.model))sessions.set(request.model,ort.InferenceSession.create(new URL('engine/models/'+request.model,import.meta.url).href,{executionProviders:['wasm'],graphOptimizationLevel:'all'}));
    const session=await sessions.get(request.model);
    if(!Array.isArray(request.dims)||request.dims.length>8||request.dims.some(v=>!Number.isSafeInteger(v)||v<1)||request.dims.reduce((a,b)=>a*b,1)*4!==request.data.byteLength)throw new Error('Invalid OCR input shape');
    const result=await session.run({[request.inputName]:new ort.Tensor('float32',new Float32Array(request.data),request.dims)});
    const output=result[session.outputNames[0]];
    if(output.type!=='float32'||output.data.byteLength>request.shared.byteLength-HEADER_BYTES)throw new Error('OCR result exceeds shared buffer');
    new Uint8Array(request.shared,HEADER_BYTES,output.data.byteLength).set(new Uint8Array(output.data.buffer,output.data.byteOffset,output.data.byteLength));
    const metadata=new TextEncoder().encode(JSON.stringify({dims:output.dims}));
    new Uint8Array(request.shared,16,metadata.length).set(metadata);
    Atomics.store(state,1,metadata.length);Atomics.store(state,2,output.data.byteLength);Atomics.store(state,0,1);
  }catch(error){
    const metadata=new TextEncoder().encode(JSON.stringify({error:String(error.message).slice(0,1000)}));
    new Uint8Array(request.shared,16,metadata.length).set(metadata);
    Atomics.store(state,1,metadata.length);Atomics.store(state,2,0);Atomics.store(state,0,-1);
  }finally{Atomics.notify(state,0);}
}
onmessage=({data})=>{if(data.type==='infer')infer(data);};
