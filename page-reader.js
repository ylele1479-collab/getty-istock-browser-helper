(function(root){
  'use strict';const core=root.GettyPluginCore;
  function snapshot({key:targetKey}={}){
    const pageUrl=location.href;let pageRef=null;try{pageRef=core.identify(pageUrl);}catch{}
    if(core.needsVerification((document.body?.innerText||'').slice(0,50000),pageUrl))return {pageUrl,status:'needs_verification',groups:[],key:pageRef?.key};
    const values=[];
    for(const image of document.querySelectorAll('img')){
      values.push(image.currentSrc,image.getAttribute('src'),image.getAttribute('data-src'),image.getAttribute('data-original'));
      for(const part of (image.getAttribute('srcset')||'').split(','))values.push(part.trim().split(/\s+/)[0]);
    }
    for(const node of document.querySelectorAll('picture source'))for(const part of (node.getAttribute('srcset')||'').split(','))values.push(part.trim().split(/\s+/)[0]);
    for(const node of document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"],meta[itemprop="image"]'))values.push(node.getAttribute('content'));
    if(pageRef){
      values.push(...core.extractCandidates(document.documentElement.outerHTML,pageRef));
      values.push(...(root.performance?.getEntriesByType('resource')||[]).map(entry=>entry.name));
    }
    const details=new Map();
    for(const link of document.querySelectorAll('a[href]')){try{const ref=core.identify(link.href);if(ref.kind==='page'&&!details.has(ref.key))details.set(ref.key,ref.url);}catch{}}
    const groups=new Map();
    for(const url of values){
      let ref;try{ref=core.identify(url);}catch{continue;}
      if(ref.kind!=='image'||pageRef&&ref.key!==pageRef.key||targetKey&&ref.key!==targetKey)continue;
      if(!groups.has(ref.key))groups.set(ref.key,{key:ref.key,provider:ref.provider,id:ref.id,pageUrl:pageRef?.key===ref.key?pageUrl:details.get(ref.key)||pageUrl,status:'ready',candidates:[]});
      groups.get(ref.key).candidates.push(ref.url);
    }
    for(const group of groups.values())group.candidates=core.candidates(group.candidates);
    return {pageUrl,key:pageRef?.key,status:groups.size?'ready':'no_source',totalCount:groups.size,groups:[...groups.values()].slice(0,20)};
  }
  function zoomButton(ref){
    const matches=node=>[...node?.querySelectorAll?.('img')||[]].some(image=>{try{return core.identify(image.currentSrc||image.getAttribute('src')).key===ref.key;}catch{return false;}});
    return [...document.querySelectorAll('button, [role="button"]')].find(node=>
      node.tagName!=='A'&&!node.getAttribute('href')&&node.getAttribute('type')!=='submit'&&
      /view larger|enlarge|zoom|放大|縮放|缩放|查看大圖|查看大图/i.test((node.getAttribute('aria-label')||'')+' '+(node.getAttribute('title')||'')+' '+(node.innerText||''))&&
      (matches(node)||matches(document.getElementById(node.getAttribute('aria-controls')))));
  }
  async function collect({enhance=false,timeout=4500,key}={}){
    const read=()=>snapshot({key});let initial=read(),ref;try{ref=core.identify(location.href);}catch{return initial;}
    if(!enhance||initial.status==='needs_verification')return initial;
    const button=zoomButton(ref);if(!button)return initial;
    const visibleDialogs=()=>[...document.querySelectorAll('dialog[open], [role="dialog"]')].filter(dialog=>!dialog.hidden&&dialog.getAttribute('aria-hidden')!=='true'&&dialog.getClientRects().length>0&&root.getComputedStyle(dialog).visibility!=='hidden');
    const previousDialogs=new Set(visibleDialogs());
    const samePhoto=image=>{try{return core.identify(image.currentSrc||image.getAttribute('src')).key===ref.key;}catch{return false;}};
    if([...previousDialogs].some(dialog=>[...dialog.querySelectorAll('img')].some(samePhoto)))return initial;
    const initialSources=new Set(initial.groups.flatMap(group=>group.candidates));
    const initialSize=Math.max(0,...[...initialSources].map(core.declaredSize),...[...document.querySelectorAll('img')].filter(samePhoto).map(image=>Math.max(image.naturalWidth||0,image.naturalHeight||0)));
    const observedSources=new Set(initialSources);
    return new Promise(resolve=>{
      let finished=false,timer,settle;
      const finish=result=>{
        if(finished)return;finished=true;observer.disconnect();clearTimeout(timer);clearTimeout(settle);document.removeEventListener('load',scan,true);
        if(location.href===initial.pageUrl)for(const dialog of visibleDialogs()){
          if(previousDialogs.has(dialog)||![...dialog.querySelectorAll('img')].some(image=>{try{return core.identify(image.currentSrc||image.getAttribute('src')).key===ref.key;}catch{return false;}}))continue;
          const close=[...dialog.querySelectorAll('button')].find(node=>/^(close|关闭|關閉)(?:\s|$)/i.test(node.getAttribute('aria-label')||node.getAttribute('title')||node.innerText||''));
          close?.click();
        }
        resolve(result);
      };
      const scan=()=>{
        if(finished)return;
        const result=read();if(result.key!==ref.key)return finish({status:'no_source',groups:[]});
        if(result.status==='needs_verification')return finish(result);
        const sources=result.groups.flatMap(group=>group.candidates),newlyObserved=sources.some(url=>!observedSources.has(url));
        sources.forEach(url=>observedSources.add(url));
        const largerObserved=sources.some(url=>!initialSources.has(url)&&core.declaredSize(url)>initialSize);
        const largerZoomLoaded=visibleDialogs().some(dialog=>!previousDialogs.has(dialog)&&[...dialog.querySelectorAll('img')].some(image=>samePhoto(image)&&image.complete&&Math.max(image.naturalWidth||0,image.naturalHeight||0)>initialSize));
        // A new small placeholder is not success. Give larger sources time to settle,
        // while the overall timeout still bounds pages that never reveal another size.
        if((largerObserved||largerZoomLoaded)&&(newlyObserved||!settle)){clearTimeout(settle);settle=setTimeout(()=>finish(read()),250);}
      };
      const observer=new MutationObserver(scan);observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','content']});
      document.addEventListener('load',scan,true);timer=setTimeout(()=>finish(read()),timeout);
      button.click();scan();
    });
  }
  root.GettyPluginReader={snapshot,collect};
})(globalThis);
