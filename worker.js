importScripts('core.js');
const core=globalThis.GettyPluginCore;
const patterns=core.PAGE_HOSTS.map(host=>'https://'+host+'/*');
async function readTab(tab,enhance=false,key=null){
  if(!tab?.id||!core.isPage(tab.url||''))throw Error('请先在浏览器打开 Getty 或 iStock 素材网页');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['core.js','page-reader.js']});
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},args:[enhance,key],func:(enhance,key)=>globalThis.GettyPluginReader.collect({enhance,key})});
  return result[0]?.result||{status:'no_source',groups:[]};
}
async function readOpenPages(key,enhance=false){
  let tabs=await chrome.tabs.query({url:patterns});
  if(key)tabs=tabs.filter(tab=>{try{return core.identify(tab.url).key===key;}catch{const page=new URL(tab.url);return page.pathname.startsWith('/search/')&&(page.hostname.includes('gettyimages.')?'getty':'istock')===key.split(':')[0];}});
  tabs.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
  const snapshots=[];
  for(const tab of tabs.slice(0,20)){
    try{snapshots.push(await readTab(tab,enhance,key));}catch(error){snapshots.push({status:'unavailable',pageUrl:tab.url,error:error.message,groups:[]});}
  }
  return snapshots;
}
async function readNormalPage(url){
  const ref=core.identify(url);if(ref.kind!=='page')throw Error('只接受同一素材的正常详情页');
  const origin=new URL(ref.url).origin;
  const tabs=(await chrome.tabs.query({url:origin+'/*'})).filter(tab=>core.isPage(tab.url||'')&&new URL(tab.url).origin===origin&&!core.needsVerification('',tab.url));
  const matching=tab=>{try{return core.identify(tab.url).key===ref.key?1:0;}catch{return 0;}};
  tabs.sort((a,b)=>matching(b)-matching(a)||(b.lastAccessed||0)-(a.lastAccessed||0));if(!tabs.length)return null;
  const reply=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},args:[ref.url,core.VERIFICATION_PATTERNS],func:async(address,verificationPatterns)=>{
    if(new URL(address).origin!==location.origin)return {error:'正常网页的地区站已变化，请重新读取。'};
    const visibleDocument='<title>'+(document.title||'')+'</title>\n'+(document.body?.innerText||'');
    if(new RegExp(verificationPatterns.url,'i').test(location.href)||new RegExp(verificationPatterns.text,'i').test(visibleDocument.slice(0,100000)))return {url:location.href,status:403,text:'User validation'};
    if(new URL(address).pathname===location.pathname){const text=document.documentElement.outerHTML;return text.length<=8_000_000?{url:location.href,status:200,text,via:'open_document'}:{error:'素材网页过大，请读取当前页中的图片。'};}
    const local=new AbortController();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;local.abort();},12000);
    try{
      const response=await fetch(address,{signal:local.signal,credentials:'include',cache:'no-store'});
      if(Number(response.headers.get('Content-Length'))>8_000_000)return {error:'素材网页过大，请读取已打开的详情页。'};
      const text=await response.text();if(text.length>8_000_000)return {error:'素材网页过大，请读取已打开的详情页。'};
      return {url:response.url,status:response.status,text,via:'normal_page'};
    }catch(error){return {error:timedOut?'正常素材页读取超时，请直接打开详情页后重新读取。':'正常素材页读取失败：'+error.message,name:timedOut?'TimeoutError':'Error'};}
    finally{clearTimeout(timer);}
  }});
  return reply[0]?.result||{error:'正常网页没有返回读取结果，请重新读取。'};
}
async function openWorkbench(){
  const url=chrome.runtime.getURL('workbench.html'),tabs=await chrome.tabs.query({url});
  if(tabs.length){await chrome.tabs.update(tabs[0].id,{active:true});await chrome.windows.update(tabs[0].windowId,{focused:true});return tabs[0];}
  return chrome.tabs.create({url,active:true});
}
chrome.action.onClicked.addListener(async tab=>{
  try{
    if(core.isPage(tab.url||'')){
      const snapshot=await readTab(tab);await chrome.storage.session.set({pendingSnapshot:snapshot});
      await openWorkbench();chrome.runtime.sendMessage({type:'PAGE_SNAPSHOT',snapshot}).catch(()=>{});
    }else await openWorkbench();
  }catch(error){await chrome.storage.session.set({pendingNotice:error.message});await openWorkbench();}
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return false;
  if(message.type==='READ_OPEN_PAGES'){
    readOpenPages(typeof message.key==='string'?message.key:null,message.enhance===true).then(snapshots=>reply({ok:true,snapshots})).catch(error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='READ_NORMAL_PAGE'){
    readNormalPage(message.url).then(page=>reply({ok:true,page})).catch(error=>reply({ok:false,error:error.message}));return true;
  }
  return false;
});
