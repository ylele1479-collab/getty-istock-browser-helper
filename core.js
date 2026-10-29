(function(root){
  'use strict';
  const GETTY_SUFFIXES=['com','ae','co.uk','de','fr','es','it','jp','com.br','com.au','ca','in','cn','nl','se','pl','mx','com.mx','co.jp','com.hk','com.sg','pt','ru','ch','at','be','dk','no','fi','gr','tr','co.kr','hk','co.nz','co.za','ie','tw'];
  const GETTY_PAGES=GETTY_SUFFIXES.flatMap(suffix=>['gettyimages.'+suffix,'www.gettyimages.'+suffix]);
  const ISTOCK_PAGES=['www.istockphoto.com','istockphoto.com'];
  const PAGE_HOSTS=[...GETTY_PAGES,...ISTOCK_PAGES];
  const LINK_START='https:\\/\\/(?:'+[...PAGE_HOSTS,'media.gettyimages.com','media.istockphoto.com','short.askingtips.com'].map(host=>host.replaceAll('.','\\.')).join('|')+')(?:[\\/:?#]|$)';
  const ID='(?:[A-Za-z]{1,4})?[0-9]{6,12}(?:-[0-9]{1,4})?';
  function identify(value){
    if(typeof value!=='string'||value.length>8192)throw Error('链接太长或格式不正确');
    const raw=value.trim(),u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('只支持 Getty / iStock 的 HTTPS 链接');
    const host=u.hostname.toLowerCase();let provider,id,kind;
    if(['media.gettyimages.com','media.istockphoto.com'].includes(host)){
      provider=host==='media.gettyimages.com'?'getty':'istock';kind='image';id=u.pathname.match(new RegExp('^/id/('+ID+')/'))?.[1];
    }else if(host==='short.askingtips.com'&&/^\/uploads\/.+\.(?:jpg|jpeg|png|webp)$/i.test(u.pathname)&&!u.search){
      provider='imported';kind='image';id='imported';
    }else if(GETTY_PAGES.includes(host)&&u.pathname.includes('/detail/')){
      provider='getty';kind='page';id=u.pathname.match(new RegExp('/('+ID+')/?$'))?.[1];
    }else if(ISTOCK_PAGES.includes(host)){
      provider='istock';kind='page';id=u.pathname.match(/-gm([0-9]{6,12})-[0-9]+\/?$/i)?.[1];
    }
    if(!id)throw Error('请使用单张 Getty / iStock 素材页，或官方图片直链');
    return {url:raw,id,provider,kind,key:provider+':'+(provider==='imported'?raw:id)};
  }
  function isPage(url){try{const u=new URL(url);return u.protocol==='https:'&&PAGE_HOSTS.includes(u.hostname);}catch{return false;}}
  function parseInput(text){
    const urls=[],errors=[],seen=new Set();let duplicates=0;
    String(text).replace(/https\\:\/\//gi,'https://').replace(/\\&/g,'&').split(/\r?\n/).forEach((line,index)=>{
      const values=line.split(/[\s,，<>]+(?=https:\/\/)/i).flatMap(value=>{
        const out=[];let start=0;
        for(const m of value.matchAll(new RegExp(LINK_START,'ig'))){
          if(m.index<=start)continue;const before=value.slice(start,m.index);
          if(/[?&][^?&=]+=$/.test(before)||/[?&][^?&=]+=https?:\/\//i.test(before))continue;
          out.push(before);start=m.index;
        }
        out.push(value.slice(start));return out;
      });
      for(let value of values){value=value.trim().replace(/^[<>]+|[<>]+$/g,'');if(!value)continue;
        try{identify(value);}catch(error){errors.push({line:index+1,message:error.message});continue;}
        if(seen.has(value)){duplicates++;continue;}seen.add(value);urls.push(value);
      }
    });return {urls,errors,duplicates,overLimit:urls.length>20};
  }
  function inputMaterials(text){
    const parsed=parseInput(text),groups=new Map();
    for(const url of parsed.urls){const ref=identify(url);if(!groups.has(ref.key))groups.set(ref.key,{key:ref.key,ref,urls:[]});groups.get(ref.key).urls.push(url);}
    return {...parsed,materials:[...groups.values()]};
  }
  function readDroppedLinks(transfer){
    const found=[];
    const unwrap=(raw,depth=0)=>{
      if(typeof raw!=='string'||raw.length>8192||depth>3||/\s/.test(raw.trim()))return;
      try{found.push(identify(raw).url);return;}catch{}
      try{const url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;
        for(const key of ['img_url','imgurl','image_url','mediaurl','url','u','rurl']){const nested=url.searchParams.get(key);if(nested)unwrap(nested,depth+1);}
      }catch{}
    };
    const data=type=>{try{return transfer.getData(type)||'';}catch{return '';}};
    const decode=value=>value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/ig,(entity,key)=>{
      if(key[0]!=='#')return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[key.toLowerCase()];
      const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):entity;
    });
    for(const tag of data('text/html').matchAll(/<(?:img|a)\b[^>]*>/ig))for(const attr of tag[0].matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/ig))unwrap(decode(attr[1]??attr[2]??attr[3]));
    for(const type of ['text/uri-list','text/plain','text/x-moz-url'])for(const line of data(type).split(/\r?\n/)){
      if(line.trim().startsWith('#'))continue;
      const parsed=parseInput(line);parsed.urls.forEach(url=>unwrap(url));
      for(const raw of line.match(/https?:\/\/[^\s<>"']+/ig)||[])unwrap(raw);
    }
    const groups=new Map();for(const url of found){const ref=identify(url),previous=groups.get(ref.key);if(!previous||identify(previous).kind==='page'&&ref.kind==='image')groups.set(ref.key,url);}
    return [...groups.values()];
  }
  function snapshotGroups(snapshots){
    const groups=new Map();
    for(const snapshot of snapshots){
      const values=[...(snapshot.key?[{key:snapshot.key,status:snapshot.status,candidates:[]}]:[]),...(snapshot.groups||[])];
      for(const group of values){
        if(!groups.has(group.key))groups.set(group.key,{key:group.key,status:'no_source',candidates:[],pageUrl:group.pageUrl||snapshot.pageUrl});
        const current=groups.get(group.key),accepted=candidates(group.candidates||[]).filter(url=>identify(url).key===group.key);
        if(accepted.length){if(!current.candidates.length)current.pageUrl=group.pageUrl||snapshot.pageUrl;current.candidates=candidates([...current.candidates,...accepted]);current.status='ready';}
        else if(current.status!=='ready'&&group.status==='needs_verification')current.status='needs_verification';
      }
    }
    return [...groups.values()];
  }
  function decodeText(text){return String(text).replace(/\\\//g,'/').replace(/\\u00(26|3d|3f|2f)/ig,(_,n)=>String.fromCharCode(parseInt(n,16))).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"');}
  function candidates(values,ref){
    const out=[];
    for(const value of values){try{const r=identify(value);if(r.kind==='image'&&(!ref||r.key===ref.key)&&!out.includes(r.url))out.push(r.url);}catch{}}
    if(out.length<=40)return out;
    const largest=out.slice().sort((a,b)=>declaredSize(b)-declaredSize(a));
    return [...new Set([...out.slice(0,8),...largest.filter(url=>new URL(url).searchParams.get('w')==='0').slice(0,8),...largest.slice(0,24)])];
  }
  function extractCandidates(text,ref){
    const decoded=decodeText(text).slice(0,8_000_000);
    return candidates(decoded.match(/https:\/\/media\.(?:gettyimages|istockphoto)\.com\/[^\s"'<>\\]+/ig)||[],ref);
  }
  function declaredSize(url){try{const s=new URL(url).searchParams.get('s')||'';if(s==='170667a')return 510;const n=s.match(/^(\d{2,5})x(\d{2,5})$/);return n?Math.max(+n[1],+n[2]):0;}catch{return 0;}}
  function rankCandidates(values,mode='largest'){
    return candidates(values).sort((a,b)=>{
      if(mode==='clean'){const clean=u=>new URL(u).searchParams.get('w')==='0';if(clean(a)!==clean(b))return clean(b)-clean(a);}
      return declaredSize(b)-declaredSize(a);
    });
  }
  const VERIFICATION_PATTERNS=Object.freeze({url:String.raw`/bot-wall|/captcha`,text:String.raw`使用者驗證|使用者验证|驗證您|验证您|user validation|validate that you are a real user|verify (?:that )?you are (?:a )?human|access verification|<title>\s*(?:access denied|just a moment)`});
  function needsVerification(text,url=''){
    return new RegExp(VERIFICATION_PATTERNS.url,'i').test(url)||new RegExp(VERIFICATION_PATTERNS.text,'i').test(String(text).slice(0,100000));
  }
  function detailUrl(ref,preferredPage=''){
    if(ref.kind==='page')return ref.url;
    if(ref.provider==='imported')return '';
    if(ref.provider==='istock')return 'https://www.istockphoto.com/search/2/image?phrase='+ref.id;
    let origin='https://www.gettyimages.com';
    try{const page=new URL(preferredPage);if(page.protocol==='https:'&&!page.username&&!page.password&&(!page.port||page.port==='443')&&GETTY_PAGES.includes(page.hostname))origin=page.origin;}catch{}
    const stem=new URL(ref.url).pathname.split('/').pop().replace(/\.[^.]+$/,'');
    return `${origin}/detail/photo/${/^[a-z0-9-]+$/i.test(stem)?stem+'-royalty-free-image':'-'}/${ref.id}`;
  }
  async function discover(ref,{readOpenPages,fetchPage,extraSources=[],forceLookup=false,preferredPage=''}){
    if(ref.provider==='imported')return {status:'ready',candidates:[ref.url],qualityNote:'第三方返回文件单独预览，不与其他素材融合。'};
    const open=(await readOpenPages(ref)).filter(item=>item.key===ref.key);
    let values=candidates([...open.flatMap(item=>item.candidates||[]),...extraSources,...(ref.kind==='image'?[ref.url]:[])],ref);
    const pageUrl=open.map(item=>item.pageUrl).find(url=>{try{return identify(url).key===ref.key;}catch{return false;}})||detailUrl(ref,preferredPage);
    let lookupAttempted=false;
    const finish=(qualityNote='',verification=false)=>({status:values.length?'ready':verification?'needs_verification':'no_source',candidates:values,pageUrl,qualityNote,verification,lookupAttempted});
    if(open.some(item=>item.status==='needs_verification'))return finish('素材网页需要人工验证，暂未取得更多高清图源。',true);
    if(!forceLookup&&values.some(url=>declaredSize(url)>=2048))return finish();
    try{
      lookupAttempted=true;
      const response=await fetchPage(pageUrl);
      if(needsVerification(response.text,response.url))return finish('素材网页需要人工验证，暂未取得更多高清图源。',true);
      let final;try{final=identify(response.url);}catch{return finish('素材网页未返回可核对的同一照片，保留已读取图源。');}
      if(final.key!==ref.key)return finish('素材网页跳转到了其他照片，未采用该页图源。');
      values=candidates([...values,...extractCandidates(response.text,ref)],ref);
      return finish(values.some(url=>declaredSize(url)>=1000)?'':'暂未发现更高分辨率图源，可在已打开素材页放大后重新读取。');
    }catch(error){if(error.name==='AbortError')throw error;return finish('高清图源查询暂不可用，保留已读取图源。');}
  }
  function fileName(ref,width,height,type){
    const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif'};
    return `${ref.provider}_${ref.id}_${width}x${height}.${extensions[type]||'jpg'}`;
  }
  function saveEligibility(payload){
    const p=payload||{},before=p.comparison_image||{},after=p.output_image||{},reasons=[];
    const valid=info=>Number.isSafeInteger(info.width)&&info.width>0&&Number.isSafeInteger(info.height)&&info.height>0;
    const watermarkPassed=p.upgrade_check?.status==='preview_checked'&&p.upgrade_check?.reason_code==='no_known_overlay_detected'&&['preview','unmodified','disabled'].includes(p.repair_check?.status)&&p.repair?.output_discarded!==true;
    const resolutionImproved=valid(before)&&valid(after)&&after.width>before.width&&after.height>before.height&&Math.max(after.width,after.height)>=1000&&p.resolution_level!=='low'&&p.upscaled===false&&p.source_check?.status==='larger_found';
    if(!watermarkPassed)reasons.push(p.upgrade_check?.reason_code==='remaining_watermark'?'仍检测到水印':'水印处理或输出检查未通过');
    if(!resolutionImproved)reasons.push(p.upscaled===true?'插值放大不能作为真实画质提升':'未取得更多真实像素或输出尺寸不足');
    return {eligible:watermarkPassed&&resolutionImproved,watermarkPassed,resolutionImproved,reasons};
  }
  const api={identify,isPage,parseInput,inputMaterials,readDroppedLinks,snapshotGroups,detailUrl,extractCandidates,candidates,rankCandidates,declaredSize,needsVerification,discover,fileName,saveEligibility,PAGE_HOSTS,VERIFICATION_PATTERNS};
  root.GettyPluginCore=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
