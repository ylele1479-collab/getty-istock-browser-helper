'use strict';
const core=globalThis.GettyPluginCore,$=s=>document.querySelector(s);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const known=new Map(),results=[],downloads=new Map(),sourceContexts=new Map();
let generation=0,batchCounter=0,savingBatch=false,controller=null,currentAbort=null,currentKey=null,pauseReply=null,verificationUrl='',viewerResult=null,downloadHistory={},inputHover=null;
const notice=(message,error=false)=>{$('#notice').textContent=message;$('#notice').classList.toggle('error',error);};
const abortError=()=>new DOMException('已停止','AbortError');
function remember(snapshot){
  rememberContext(snapshot);
  for(const group of core.snapshotGroups([snapshot]))known.set(group.key,group);
}
function rememberContext(snapshot,replace=true){
  if(snapshot.status!=='ready'||!core.isPage(snapshot.pageUrl))return;
  const provider=new URL(snapshot.pageUrl).hostname.includes('gettyimages.')?'getty':'istock';
  if(replace||!sourceContexts.has(provider))sourceContexts.set(provider,snapshot.pageUrl);
}
const materialPage=ref=>core.detailUrl(ref,sourceContexts.get(ref.provider));
function updateInputSummary(){
  const input=core.inputMaterials($('#urls').value),messages=[`已识别 ${input.materials.length} 张图片（${input.urls.length} 条链接）`];
  if(input.duplicates)messages.push(`合并了 ${input.duplicates} 条重复链接`);
  if(input.errors.length)messages.push(`第 ${[...new Set(input.errors.map(e=>e.line))].join('、')} 行格式不正确`);
  if(input.overLimit)messages.push('超过20条，请减少后再解析；未截断输入');
  $('#inputStatus').textContent=messages.join(' · ');$('#inputStatus').classList.toggle('error',!!input.errors.length||input.overLimit);
  $('#inputMaterials').innerHTML=input.materials.map((item,index)=>`<div class="input-material"><span>${index+1}. ${item.ref.provider==='imported'?'第三方返回图片':`${item.ref.provider==='getty'?'Getty':'iStock'} · ${escape(item.ref.id)}`}</span><div><button class="secondary small" data-delete="${escape(item.key)}">删除</button>${item.ref.provider!=='imported'?`<a data-preview-key="${escape(item.key)}" href="${escape(materialPage(item.ref))}" target="_blank" rel="noopener noreferrer">正常素材页 ↗</a>`:''}</div></div>`).join('');
  inputHover?.refresh();
  return input;
}
function appendLinks(values){
  const existing=core.parseInput($('#urls').value).urls,merged=[...new Set([...existing,...values])];
  $('#urls').value=merged.join('\n');const parsed=updateInputSummary();
  notice(parsed.overLimit?'已显示全部链接，单批最多20条，请先删除多余链接。':`已添加 ${parsed.materials.length} 张图片，可开始解析。`,parsed.overLimit);
}
function appendSnapshot(snapshot){
  remember(snapshot);
  if(snapshot.status==='needs_verification'){notice('当前素材页仍在验证。请在正常网页完成验证后，再读取。',true);return;}
  const values=(snapshot.groups||[]).map(group=>core.rankCandidates(group.candidates,$('#mode').value)[0]).filter(Boolean);
  if(values.length)appendLinks(values);else notice('这页还没有可读取的图片。请等素材图显示后再读取。',true);
  if(snapshot.totalCount>20)notice(`网页读到 ${snapshot.totalCount} 张图片，本批先添加20张。`);
}
async function readPages(add=true,key=null,enhance=false){
  const mine=generation;
  const answer=await chrome.runtime.sendMessage({type:'READ_OPEN_PAGES',key,enhance});
  if(!answer?.ok)throw Error(answer?.error||'网页读取失败，请重试');
  const snapshots=answer.snapshots||[];for(const group of core.snapshotGroups(snapshots))known.set(group.key,group);
  if(!key)sourceContexts.clear();for(const snapshot of snapshots)rememberContext(snapshot,false);
  if(add&&mine===generation){const groups=snapshots.flatMap(s=>s.groups||[]);if(groups.length)appendLinks(groups.map(g=>core.rankCandidates(g.candidates,$('#mode').value)[0]).filter(Boolean));
    else notice(snapshots.some(s=>s.status==='needs_verification')?'素材页需要验证。完成正常验证后，再读取。':'没有读到图片，请先打开素材页或粘贴图片链接。',true);}
  return snapshots;
}
async function fetchTimed(url,signal,read,seconds=20){
  const local=new AbortController(),cancel=()=>local.abort();
  if(signal?.aborted)throw abortError();
  let timedOut=false;signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(()=>{timedOut=true;local.abort();},seconds*1000);
  try{return await read(await fetch(url,{signal:local.signal,credentials:'include',cache:'no-store'}));}
  catch(error){if(timedOut&&!signal?.aborted)throw Object.assign(Error('网页或图片读取超时，请稍后重试或读取已打开的素材页。'),{name:'TimeoutError'});throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
async function fetchPage(url,signal){
  if(globalThis.chrome?.runtime?.sendMessage){
    if(signal?.aborted)throw abortError();
    const answer=await new Promise((resolve,reject)=>{
      const cancel=()=>reject(abortError());signal?.addEventListener('abort',cancel,{once:true});
      chrome.runtime.sendMessage({type:'READ_NORMAL_PAGE',url}).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',cancel));
    });
    if(!answer?.ok)throw Error(answer?.error||'正常素材页读取失败，请重试。');
    if(answer.page?.error)throw Object.assign(Error(answer.page.error),{name:answer.page.name||'Error'});
    if(answer.page)return answer.page;
  }
  return fetchTimed(url,signal,async response=>{
    if(Number(response.headers.get('Content-Length'))>8_000_000)throw Error('素材网页过大，请改用读取已打开网页');
    const text=await response.text();return {text:text.slice(0,8_000_000),url:response.url,status:response.status};
  },12);
}
async function fetchImage(url,ref,signal){
  return fetchTimed(url,signal,async response=>{
    if(!response.ok)throw Error(`图片返回 HTTP ${response.status}`);
    let final;try{final=core.identify(response.url);}catch{throw Error('图片跳转到不支持的地址');}
    if(final.kind!=='image'||final.key!==ref.key)throw Error('跳转后的素材编号不一致');
    if(Number(response.headers.get('Content-Length'))>30_000_000)throw Error('单张图片超过30MB');
    const blob=await response.blob();if(blob.size>30_000_000||!blob.size)throw Error('图片大小不符合要求');
    let bitmap;try{bitmap=await createImageBitmap(blob);}catch{throw Error('返回内容不是可解码图片，可能需要网页验证');}
    const {width,height}=bitmap;bitmap.close();if(width*height>60_000_000)throw Error('单张图片像素过大');
    if(signal.aborted)throw abortError();
    return {blob,width,height,url,bytes:await blob.arrayBuffer()};
  });
}
async function resolveImage(item,signal,extraSources=[]){
  const ref=item.ref,crossSources=core.rankCandidates(extraSources.filter(url=>core.identify(url).provider!==ref.provider),$('#mode').value);
  if($('#autoEnlarge').checked&&ref.provider!=='imported'){
    $('#engineStatus').textContent='正在读取已打开素材页的正常放大图源…';await readPages(false,ref.key,true);
  }
  if(signal.aborted)throw abortError();
  const found=await core.discover(ref,{forceLookup:true,preferredPage:sourceContexts.get(ref.provider),readOpenPages:async()=>known.has(ref.key)?[known.get(ref.key)]:[],fetchPage:u=>fetchPage(u,signal),extraSources:[...extraSources,...item.urls.filter(url=>core.identify(url).kind==='image')]});
  if(found.status==='needs_verification')throw Object.assign(Error('网站要求人工验证。请在正常素材页完成后继续。'),{verification:true,ref,pageUrl:found.pageUrl});
  if(!found.candidates.length)throw Error('没有取得可用图源。请手动打开素材页，待图片显示后再读取。');
  const ordered=core.rankCandidates(found.candidates,'largest'),clean=ordered.filter(u=>new URL(u).searchParams.get('w')==='0'),marked=ordered.filter(u=>new URL(u).searchParams.get('w')!=='0');
  const selected=[...[...new Set([...(ref.kind==='image'?[ref.url]:[]),...marked.slice(0,4),...clean.slice(0,2),...ordered])].slice(0,8),...crossSources.filter(url=>new URL(url).searchParams.get('w')!=='0').slice(0,4),...crossSources.filter(url=>new URL(url).searchParams.get('w')==='0').slice(0,2)];
  const fetched=[],outcomes=new Array(selected.length);let last,next=0;
  const acquire=async()=>{
    while(!signal.aborted){
      const index=next++;if(index>=selected.length)return;const url=selected[index];
      try{outcomes[index]={value:await fetchImage(url,crossSources.includes(url)?core.identify(url):ref,signal)};}
      catch(error){outcomes[index]={error};}
    }
  };
  await Promise.all(Array.from({length:Math.min(4,selected.length)},acquire));
  if(signal.aborted)throw abortError();
  for(const outcome of outcomes){if(outcome.value)fetched.push(outcome.value);else last=outcome.error;}
  const sufficient=image=>core.identify(image.url).provider===ref.provider&&(ref.provider==='istock'?Math.max(image.width,image.height)>=2048&&Math.min(image.width,image.height)>=1080:Math.max(image.width,image.height)>=1000);
  if(ref.provider!=='imported'&&!fetched.some(sufficient)&&!found.lookupAttempted&&!found.verification){
    const retry=await core.discover(ref,{forceLookup:true,preferredPage:sourceContexts.get(ref.provider),readOpenPages:async()=>known.has(ref.key)?[known.get(ref.key)]:[],fetchPage:u=>fetchPage(u,signal),extraSources:[...extraSources,...item.urls.filter(url=>core.identify(url).kind==='image')]});
    const additional=core.rankCandidates(retry.candidates,'largest').filter(url=>!selected.includes(url)).slice(0,4);
    for(const url of additional){try{fetched.push(await fetchImage(url,ref,signal));}catch(error){if(signal.aborted)throw error;last=error;}}
    Object.assign(found,retry);
  }
  if(!fetched.length)throw last||Error('图片暂时不可用');
  if(ref.kind==='image'&&!fetched.some(image=>image.url===ref.url))throw Error('输入图片未能读取，无法可靠进行前后对照。请检查该链接。');
  if(found.verification&&!fetched.some(sufficient)&&!fetched.some(image=>crossSources.includes(image.url)&&Math.max(image.width,image.height)>=1000))throw Object.assign(Error('高清图源查询被官网验证拦住，目前只取得原小图，尚未提升画质。请在正常素材页处理后继续，或跳过这张。'),{verification:true,ref,pageUrl:found.pageUrl});
  $('#engineStatus').textContent='正在核验实际像素，并按旧版流程处理…';
  if(!globalThis.PluginEngine)throw Error('图像处理引擎文件缺失，请重新完整解压插件包。');
  const processed=await PluginEngine.process({inputUrl:ref.url,candidates:fetched.map(({url,bytes})=>({url,bytes})),extraSources:crossSources,allowRepair:$('#allowRepair').checked},{signal,onProgress:message=>{if(!signal.aborted)$('#engineStatus').textContent=message;}});
  if(signal.aborted)throw abortError();
  const payload=processed.payload;if(payload.error)throw Error(payload.error.message||'图像处理失败');
  const mime=info=>({'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp','GIF':'image/gif'}[info?.format]||'application/octet-stream');
  const variant=(bytes,info)=>{const blob=new Blob([bytes],{type:mime(info)});return {blob,objectUrl:URL.createObjectURL(blob),...info};};
  const output=variant(processed.output,payload.output_image),comparison=variant(processed.comparison,payload.comparison_image);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await output.blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
  return {ref,inputUrl:ref.url,sourceUrl:payload.source_url||ref.url,payload,variants:{output,comparison},...output,hash,filename:processed.filename||payload.filename,qualityNote:found.qualityNote,pageUrl:found.pageUrl};
}
function revokeResult(result){for(const version of Object.values(result.variants||{}))URL.revokeObjectURL(version.objectUrl);}
function updateDownloadAll(){
  const remaining=results.filter(result=>core.saveEligibility(result.payload).eligible&&!result.saved&&!result.downloading).length;
  const button=$('#downloadAll');button.hidden=!results.length;button.disabled=savingBatch||!remaining;button.textContent=remaining?`保存合格图片（${remaining} 张）`:'暂无可保存的合格图片';
}
function materialHeader(item){
  const ref=item.ref,url=item.inputUrl||ref.url;
  return `<div class="material-heading"><h3>${ref.provider==='getty'?'Getty Images':ref.provider==='istock'?'iStock':'返回图片'} · ${escape(ref.id)}</h3>${item.order?`<span class="result-order">第 ${item.order} / ${item.total} 张</span><span class="result-batch">第 ${item.batch} 批</span>`:''}<a class="original-link" href="${escape(url)}" title="${escape(url)}" target="_blank" rel="noopener noreferrer">原链接 ↗</a></div>`;
}
function placeCard(article,item){if(item.slot?.isConnected)item.slot.replaceWith(article);else $('#results').append(article);}
function renderPending(item){
  const article=document.createElement('article');article.className='result pending';article.dataset.key=item.ref.key;
  article.innerHTML=`<div class="result-top">${materialHeader(item)}<span class="pill">正在解析</span></div><p class="hint" role="status">正在查找同素材高清图源并检查水印…</p>`;
  $('#results').append(article);return article;
}
function deleteMaterial(key){
  $('#urls').value=core.parseInput($('#urls').value).urls.filter(url=>core.identify(url).key!==key).join('\n');updateInputSummary();
  if(currentKey===key){pauseReply?.('skip');currentAbort?.abort();}
  for(let i=results.length-1;i>=0;i--)if(results[i].ref.key===key){const result=results.splice(i,1)[0];result.article.remove();revokeResult(result);if(viewerResult===result){$('#viewer').close();viewerResult=null;}}
  for(const node of $('#results').children)if(node.dataset.key===key)node.remove();
  updateDownloadAll();notice('已移除该图片及预览，已下载文件保留。');
}
function renderResult(result){
  const p=result.payload,before=p.comparison_image,after=p.output_image,article=document.createElement('article');article.className='result';article.dataset.key=result.ref.key;
  const low=p.resolution_level==='low'||Math.max(after.width,after.height)<1000,unchanged=after.width*after.height<=before.width*before.height;
  const beforeLabel='解析前',qualification=core.saveEligibility(p);
  const source=p.source_image||after,sourceStatus=source.width*source.height>after.width*after.height?`<p class="source-fallback-status quality-note">已取得 ${source.width} × ${source.height} 高清图源；处理检查未通过，当前保留 ${after.width} × ${after.height} 原图，未提升画质。</p>`:'';
  article.innerHTML=`<div class="result-top">${materialHeader(result)}<span class="pill ${low||unchanged?'warning':''}">${qualification.eligible?'两项通过 · 可保存':'未达标 · 禁止保存'}</span><button class="secondary small" data-action="delete">删除</button></div><div class="comparison-grid"><figure><figcaption>${beforeLabel} <span>${before.width} × ${before.height}</span></figcaption><button class="preview" data-action="comparison" aria-label="放大解析前"><img src="${result.variants.comparison.objectUrl}" alt="解析前" draggable="false"></button></figure><figure><figcaption>解析后 <span>${after.width} × ${after.height}</span></figcaption><button class="preview" data-action="preview" aria-label="放大解析后"><img src="${result.objectUrl}" alt="解析后" draggable="false"></button></figure></div><p class="result-meta ${low||unchanged?'low':''}">${after.width} × ${after.height} · ${(result.blob.size/1024).toFixed(1)} KB${low?' · 当前为小图':''}${unchanged?' · 未取得更多真实像素':''}</p>${sourceStatus}<p class="quality-note">${escape(p.quality_note||'')}${p.modified?' 局部修补区来自小图，请检查接缝与细节。':''}</p>${result.qualityNote?`<p class="hint">${escape(result.qualityNote)}</p>`:''}<div class="result-bottom"><button class="secondary small" data-action="preview">试看 / 放大</button><button class="primary" data-action="download" ${qualification.eligible?'':'disabled'}>${qualification.eligible?'保存':'禁止保存'}</button></div><div class="quality-checks"><span class="${qualification.watermarkPassed?'passed':'blocked'}">水印检查：${qualification.watermarkPassed?'通过':'未通过'}</span><span class="${qualification.resolutionImproved?'passed':'blocked'}">真实像素：${qualification.resolutionImproved?'已提升':'未提升'}</span></div><p class="save-status ${qualification.eligible?'':'blocked'}" role="status">${qualification.eligible?'两项检查均通过，可保存。':'禁止保存：'+escape(qualification.reasons.join('；'))+'。'}</p>${!qualification.eligible&&result.pageUrl?`<p class="hint"><a href="${escape(result.pageUrl)}" target="_blank" rel="noopener noreferrer">打开对应素材页 ↗</a>，待图片显示后回到插件读取并重新解析。</p>`:''}<details><summary>更多对照与说明</summary><div class="actions"><button class="secondary small" data-action="copy">复制原链接</button></div><p class="hint">${p.comparison_is_input===false?'解析前为同素材较小参考图。':'解析前为输入链接的原图。'} 实际取得图源 ${p.source_image.width} × ${p.source_image.height}；${escape(p.source_check?.reason||'')}</p><ul class="hint">${(p.notes||[]).map(note=>`<li>${escape(note)}</li>`).join('')}</ul><a class="result-link" href="${escape(result.inputUrl)}" target="_blank" rel="noopener noreferrer">${escape(result.inputUrl)}</a>${result.pageUrl?`<a href="${escape(result.pageUrl)}" target="_blank" rel="noopener noreferrer">手动打开正常素材页</a>`:''}</details>`;
  article.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
    if(action==='preview'||action==='comparison')openViewer(result,action==='preview'?'output':action);
    if(action==='download')downloadResult(result);if(action==='delete')deleteMaterial(result.ref.key);
    if(action==='copy')navigator.clipboard.writeText(result.inputUrl).then(()=>{button.textContent='已复制';}).catch(()=>notice('请从来源链接手动复制。',true));});
  result.article=article;placeCard(article,result);updateDownloadAll();
}
function renderError(item,error){const article=document.createElement('article');article.className='result error';article.dataset.key=item.ref.key;article.innerHTML=`<div class="result-top">${materialHeader(item)}<span class="pill warning">禁止保存</span></div><p>${escape(error.message)}</p>${item.ref.provider!=='imported'?`<a href="${escape(materialPage(item.ref))}" target="_blank" rel="noopener noreferrer">手动打开正常素材页</a>`:''}<p class="hint">${escape(item.ref.url)}</p>`;placeCard(article,item);}
function clearResults(){results.forEach(revokeResult);results.length=0;downloads.clear();$('#results').replaceChildren();$('#downloadAll').hidden=true;$('#summary').textContent='';$('#viewer').close();viewerResult=null;}
async function waitForVerification(item,error,signal){
  verificationUrl=error.pageUrl||materialPage(item.ref);$('#verificationActions').hidden=false;notice(error.message||'当前图片需要网页验证。请手动完成后继续，也可以跳过这张。',true);
  const badge=item.slot?.querySelector?.('.pill');if(badge)badge.textContent='需要验证 · 高清未取得';
  const answer=await new Promise(resolve=>{const end=value=>{signal.removeEventListener('abort',cancel);pauseReply=null;resolve(value);};const cancel=()=>end('skip');pauseReply=end;signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
  $('#verificationActions').hidden=true;return answer;
}
async function parse(){
  if(controller)return;const input=updateInputSummary(),supplement=core.parseInput($('#sourceUrls').value);
  if(input.errors.length||input.overLimit||!input.materials.length){notice(input.errors.length?'输入中有格式错误，请先检查。':input.overLimit?'最多一次解析20条链接。':'请先添加链接。',true);return;}
  if(supplement.errors.length||supplement.overLimit||(supplement.urls.length&&(input.materials.length!==1||supplement.urls.some(url=>{const source=core.identify(url),ref=input.materials[0].ref;return ref.provider==='imported'||source.kind!=='image'||source.id!==ref.id||!(source.provider===ref.provider||ref.provider==='istock'&&source.provider==='getty');})))){notice('补充图源仅用于单张解析，最多20条，须为同素材官方图片地址；iStock 的 Getty 补充图仍须通过同照片核对。',true);return;}
  const mine=++generation,batch=++batchCounter;input.materials.forEach((item,index)=>Object.assign(item,{order:index+1,total:input.materials.length,batch}));controller=new AbortController();const signal=controller.signal;let batchReady=0;$('#parse').disabled=true;$('#stop').hidden=false;
  try{
    await readPages(false);updateInputSummary();
    for(let index=0;index<input.materials.length&&!signal.aborted;index++){
      const item=input.materials[index];if(!core.inputMaterials($('#urls').value).materials.some(m=>m.key===item.key))continue;
      currentKey=item.key;item.slot=renderPending(item);currentAbort=new AbortController();const local=currentAbort,cancel=()=>local.abort();signal.addEventListener('abort',cancel,{once:true});
      try{
        let retry=true;
        while(retry&&!local.signal.aborted){retry=false;notice(`正在解析 ${index+1}/${input.materials.length}，完成一张就显示一张。`);
          try{const result=await resolveImage(item,local.signal,supplement.urls);if(mine!==generation||local.signal.aborted){revokeResult(result);break;}Object.assign(result,{order:item.order,total:item.total,batch:item.batch,slot:item.slot});results.push(result);batchReady++;renderResult(result);}
          catch(error){if(mine!==generation||local.signal.aborted)break;if(error.verification){const action=await waitForVerification(item,error,local.signal);if(mine!==generation||local.signal.aborted)break;if(action==='retry'){await readPages(false,item.key,$('#autoEnlarge').checked);if(mine!==generation||local.signal.aborted)break;retry=true;}else renderError(item,Error('已跳过此图片，未保存。'));}else renderError(item,error);}
        }
      }finally{signal.removeEventListener('abort',cancel);if(currentAbort===local)currentAbort=null;if(mine===generation&&item.slot?.isConnected)renderError(item,Error('已停止此图片，未保存。'));}
      if(mine!==generation)break;
      $('#summary').textContent=`本批已处理 ${index+1}/${input.materials.length} 张 · 可预览 ${batchReady} 张 · 累计预览 ${results.length} 张 · 未自动保存`;
      updateDownloadAll();
    }
    if(mine===generation){const qualified=results.filter(result=>result.batch===batch&&core.saveEligibility(result.payload).eligible).length;notice(signal.aborted?'已停止。仅合格的预览可以保存。':`本批处理 ${batchReady} 张，可保存 ${qualified} 张；水印检查和真实像素提升必须同时通过。`);$('#engineStatus').textContent=signal.aborted?'已停止处理。':'本次处理结束。未通过检查的结果仅供查看，禁止保存。';}
  }catch(error){if(mine===generation)notice(signal.aborted?'已停止。':error.message,true);}
  finally{if(mine===generation){controller=null;currentKey=null;currentAbort=null;$('#parse').disabled=false;$('#stop').hidden=true;$('#verificationActions').hidden=true;}}
}
async function downloadResult(result){
  if(result.downloading||result.saved)return;const status=result.article.querySelector('.save-status'),button=result.article.querySelector('[data-action=download]');
  const qualification=core.saveEligibility(result.payload);if(!qualification.eligible){status.textContent='禁止保存：'+qualification.reasons.join('；')+'。';status.classList.add('blocked');button.disabled=true;if(viewerResult===result)$('#viewerDownload').disabled=true;return;}
  result.downloading=true;button.disabled=true;
  try{
    if(PluginSaver.state().fixed){
      if(!PluginSaver.state().hasDirectory){await PluginSaver.pick();refreshDirectory();}
      const saved=await PluginSaver.save(result.blob,result.filename,result.hash);
      status.textContent=saved.duplicate?`发现重复图片：${saved.filename}，本次未保存。`:`已保存到 ${saved.directory} / ${saved.filename}`;
      if(saved.duplicate){status.classList.add('duplicate-alert');return;}
      result.saved=!!saved.saved;
    }else{
      const prior=downloadHistory[result.hash];if(prior){const found=(await chrome.downloads.search({id:prior.id}))[0];if(found&&found.exists!==false&&['in_progress','complete'].includes(found.state)){status.textContent='下载目录中已有相同内容，本次未重复下载。';status.classList.add('duplicate-alert');return;}}
      const id=await chrome.downloads.download({url:result.objectUrl,filename:'Getty-iStock/'+result.filename,saveAs:$('#saveAs').checked,conflictAction:'uniquify'});
      result.saved=true;downloads.set(id,result);downloadHistory[result.hash]={id,time:Date.now()};
      const keys=Object.keys(downloadHistory).sort((a,b)=>downloadHistory[b].time-downloadHistory[a].time);for(const key of keys.slice(200))delete downloadHistory[key];await chrome.storage.local.set({downloadHistory});
      status.textContent='已开始下载，可在浏览器下载记录中查看。';const current=(await chrome.downloads.search({id}))[0];if(current?.state==='complete')status.textContent='下载完成。';
    }
    if(result.saved){status.classList.add('ok');button.textContent='已下载';}
  }catch(error){status.textContent='下载未完成：'+error.message;}
  finally{result.downloading=false;button.disabled=!!result.saved||!core.saveEligibility(result.payload).eligible;updateDownloadAll();if(viewerResult===result)$('#viewerDownload').disabled=button.disabled;}
}
function openViewer(result,mode='output'){
  mode=mode==='comparison'?'comparison':'output';viewerResult=result;$('#viewerMode').value=mode;const image=result.variants[mode],label=mode==='output'?'解析后':'解析前';
  $('#viewerDownload').disabled=!!result.saved||!!result.downloading||!core.saveEligibility(result.payload).eligible;$('#viewerDownload').textContent=core.saveEligibility(result.payload).eligible?'保存解析后':'未通过检查，禁止保存';
  $('#viewerTitle').textContent=`${result.ref.id} · ${image.width} × ${image.height} · ${label}`;$('#viewerImage').src=image.objectUrl;resetViewerZoom();if(!$('#viewer').open)$('#viewer').showModal();
}
function cycleViewer(step){if(!viewerResult)return;const modes=['comparison','output'];openViewer(viewerResult,modes[(modes.indexOf($('#viewerMode').value)+step+2)%2]);}
function cancelPan(){const current=pan;pan=null;if(current&&$('#viewerScroll').hasPointerCapture?.(current.pointerId))$('#viewerScroll').releasePointerCapture(current.pointerId);}
function resetViewerZoom(){cancelPan();$('#viewerImage').classList.remove('actual');$('#viewerImage').style.width='';$('#viewerZoom').textContent='放大查看';$('#viewerZoom').setAttribute('aria-pressed','false');$('#viewerScroll').scrollLeft=$('#viewerScroll').scrollTop=0;}
function zoomViewer(){const image=$('#viewerImage');if(image.classList.contains('actual')){resetViewerZoom();return;}const fitted=image.getBoundingClientRect();cancelPan();image.classList.add('actual');image.style.width=Math.max(image.naturalWidth,fitted.width*2)+'px';$('#viewerZoom').textContent='还原大小';$('#viewerZoom').setAttribute('aria-pressed','true');$('#viewerScroll').scrollLeft=Math.max(0,(image.width-$('#viewerScroll').clientWidth)/2);$('#viewerScroll').scrollTop=Math.max(0,(image.height-$('#viewerScroll').clientHeight)/2);}
function refreshDirectory(){const state=PluginSaver.state();$('#fixedDownload').checked=state.fixed;$('#directoryName').textContent=state.hasDirectory?state.directoryName:'使用浏览器下载目录';$('#directoryStatus').textContent=state.fixed?(state.hasDirectory?'已记住所选目录，保存时如需授权会由浏览器提示。':'请选择一个目录。'):'不固定目录时使用浏览器下载设置。';}
chrome.downloads.onChanged.addListener(delta=>{const result=downloads.get(delta.id);if(!result)return;const status=result.article.querySelector('.save-status');if(delta.state?.current==='complete')status.textContent='下载完成。';if(delta.state?.current==='interrupted'){result.saved=false;delete downloadHistory[result.hash];chrome.storage.local.set({downloadHistory});status.textContent='下载中断，可以重试。';status.classList.remove('ok');const button=result.article.querySelector('[data-action=download]');button.disabled=false;button.textContent='重试下载';}});
$('#parse').addEventListener('click',parse);$('#stop').addEventListener('click',()=>{controller?.abort();currentAbort?.abort();pauseReply?.('skip');});
$('#clear').addEventListener('click',()=>{generation++;controller?.abort();currentAbort?.abort();pauseReply?.('skip');globalThis.PluginEngine?.reset();controller=null;currentAbort=null;currentKey=null;clearResults();$('#urls').value='';$('#sourceUrls').value='';updateInputSummary();$('#parse').disabled=false;$('#stop').hidden=true;$('#verificationActions').hidden=true;notice('已清空，已下载文件保留。');});
$('#urls').addEventListener('input',updateInputSummary);$('#inputMaterials').addEventListener('click',event=>{const button=event.target.closest('[data-delete]');if(button)deleteMaterial(button.dataset.delete);});
$('#readPages').addEventListener('click',async()=>{const button=$('#readPages');button.disabled=true;try{await readPages(true,null,$('#autoEnlarge').checked);}catch(error){notice(error.message,true);}finally{button.disabled=false;}});
$('#paste').addEventListener('click',async()=>{const mine=generation;try{const text=await navigator.clipboard.readText();if(mine!==generation)return;if(text.trim()){$('#urls').value=[$('#urls').value.trim(),text.trim()].filter(Boolean).join('\n');updateInputSummary();notice('已粘贴并统计图片数量。');}}catch{if(mine!==generation)return;$('#urls').focus();notice('请在输入框按 Ctrl+V 粘贴。');}});
async function downloadQualified(){if(savingBatch)return;const button=$('#downloadAll'),qualified=results.filter(result=>core.saveEligibility(result.payload).eligible&&!result.saved&&!result.downloading);if(!qualified.length){notice('没有同时通过水印检查和真实像素提升检查的图片，未保存。',true);updateDownloadAll();return;}savingBatch=true;button.disabled=true;try{for(const result of qualified)if(results.includes(result))await downloadResult(result);}catch(error){notice(error.message,true);}finally{savingBatch=false;updateDownloadAll();}}
$('#downloadAll').addEventListener('click',downloadQualified);
$('#downloadFolder').addEventListener('click',()=>chrome.downloads.showDefaultFolder());
$('#pickDirectory').addEventListener('click',async()=>{try{await PluginSaver.pick();refreshDirectory();}catch(error){$('#directoryStatus').textContent=error.name==='AbortError'?'已取消选择目录。':error.message;}});
$('#fixedDownload').addEventListener('change',async()=>{try{await PluginSaver.setFixed($('#fixedDownload').checked);refreshDirectory();}catch(error){notice(error.message,true);}});
$('#listDirectory').addEventListener('click',async()=>{try{const files=await PluginSaver.list();$('#directoryTitle').textContent=PluginSaver.state().directoryName;$('#directoryFiles').innerHTML=files.length?files.map(file=>`<p>${file.kind==='directory'?'📁':'▧'} ${escape(file.name)} ${file.size!=null?`<span class="hint">${(file.size/1024).toFixed(1)} KB</span>`:''}</p>`).join(''):'<p>目录为空。</p>';$('#directoryDialog').showModal();}catch(error){$('#directoryStatus').textContent=error.message;}});
$('#closeDirectory').addEventListener('click',()=>$('#directoryDialog').close());
$('#focusSource').addEventListener('click',()=>{if(verificationUrl)window.open(verificationUrl,'_blank','noopener,noreferrer');});$('#resume').addEventListener('click',()=>pauseReply?.('retry'));$('#skip').addEventListener('click',()=>pauseReply?.('skip'));
$('#closeViewer').addEventListener('click',()=>$('#viewer').close());$('#viewer').addEventListener('close',()=>cancelPan());$('#viewerScroll').addEventListener('dblclick',event=>{event.preventDefault();zoomViewer();});$('#viewerZoom').addEventListener('click',zoomViewer);$('#viewerMode').addEventListener('change',()=>viewerResult&&openViewer(viewerResult,$('#viewerMode').value));$('#viewerPrev').addEventListener('click',()=>cycleViewer(-1));$('#viewerNext').addEventListener('click',()=>cycleViewer(1));$('#viewerDownload').addEventListener('click',()=>viewerResult&&downloadResult(viewerResult));
let pan=null;$('#viewerScroll').addEventListener('pointerdown',event=>{if(!$('#viewerImage').classList.contains('actual')||event.button!==0)return;pan={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:$('#viewerScroll').scrollLeft,top:$('#viewerScroll').scrollTop,dragging:false};});$('#viewerScroll').addEventListener('pointermove',event=>{if(!pan||pan.pointerId!==event.pointerId)return;if(event.buttons!==1){cancelPan();return;}if(!pan.dragging&&Math.hypot(event.clientX-pan.x,event.clientY-pan.y)<4)return;if(!pan.dragging){pan.dragging=true;$('#viewerScroll').setPointerCapture(event.pointerId);}$('#viewerScroll').scrollLeft=pan.left+pan.x-event.clientX;$('#viewerScroll').scrollTop=pan.top+pan.y-event.clientY;event.preventDefault();});for(const type of ['pointerup','pointercancel','lostpointercapture'])$('#viewerScroll').addEventListener(type,cancelPan);
window.addEventListener('keydown',event=>{if(!$('#viewer').open||event.ctrlKey||event.altKey||event.metaKey||event.target?.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName))return;if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(event.key)){event.preventDefault();cycleViewer(['ArrowLeft','a','A'].includes(event.key)?-1:1);}});
$('#backToTop').addEventListener('click',()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
$('#backToBottom').addEventListener('click',()=>window.scrollTo({top:(document.scrollingElement||document.documentElement).scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
$('#urls').addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='Enter')parse();});
let dragDepth=0;document.addEventListener('dragenter',event=>{if([...event.dataTransfer.types].some(t=>['text/uri-list','text/plain','text/html','text/x-moz-url','Files'].includes(t))){dragDepth++;document.body.classList.add('drop-target');}});document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('drop-target');}});document.addEventListener('dragover',event=>{if(document.body.classList.contains('drop-target'))event.preventDefault();});document.addEventListener('dragend',()=>{dragDepth=0;document.body.classList.remove('drop-target');});document.addEventListener('drop',event=>{dragDepth=0;document.body.classList.remove('drop-target');if(event.target.closest('#sourceUrls'))return;event.preventDefault();const values=core.readDroppedLinks(event.dataTransfer);if(values.length)appendLinks(values);else notice('未识别到支持的图片链接，请从网页图片拖入或复制图片地址；本地图片文件不能直接解析。',true);});
$('#sampleBoy').addEventListener('click',()=>appendLinks(['https://media.gettyimages.com/id/184602089/zh/%E7%85%A7%E7%89%87/skeptical-boy.jpg?s=612x612&w=0&k=20&c=2c3oThta9qm_o0fJLRxfys5B_yDHIFd6xD7vsq_uM_M=']));$('#sampleMan').addEventListener('click',()=>appendLinks(['https://media.gettyimages.com/id/1223379012/zh/%E7%85%A7%E7%89%87/suspicious-young-man.jpg?s=612x612&w=0&k=20&c=zNbOL3OxN41W7U0Yz-jyipGtVEMxgymJ3JiMLnTV_IY=']));
for(const id of ['mode','saveAs','allowRepair','autoEnlarge'])$('#'+id).addEventListener('change',()=>chrome.storage.local.set({mode:$('#mode').value,saveAs:$('#saveAs').checked,allowRepair:$('#allowRepair').checked,autoEnlarge:$('#autoEnlarge').checked}));
chrome.runtime.onMessage.addListener(message=>{if(message.type==='PAGE_SNAPSHOT'){appendSnapshot(message.snapshot);chrome.storage.session.remove('pendingSnapshot');}});
inputHover=GettyHoverPreview.mount({container:$('#inputMaterials'),tooltip:$('#inputHoverPreview'),getItem:key=>core.inputMaterials($('#urls').value).materials.find(item=>item.key===key),getKnown:key=>known.get(key),fetchImage:(...args)=>fetchImage(...args),fetchPage:(...args)=>fetchPage(...args)});
updateInputSummary();
(async()=>{await PluginSaver.init();refreshDirectory();const settings=await chrome.storage.local.get(['mode','saveAs','allowRepair','autoEnlarge','downloadHistory']);$('#mode').value=settings.mode||'largest';$('#saveAs').checked=!!settings.saveAs;$('#allowRepair').checked=settings.allowRepair!==false;$('#autoEnlarge').checked=settings.autoEnlarge!==false;downloadHistory=settings.downloadHistory||{};const pending=await chrome.storage.session.get(['pendingSnapshot','pendingNotice']);if(pending.pendingSnapshot)appendSnapshot(pending.pendingSnapshot);if(pending.pendingNotice)notice(pending.pendingNotice,true);await chrome.storage.session.remove(['pendingSnapshot','pendingNotice']);})().catch(error=>notice(error.message,true));
