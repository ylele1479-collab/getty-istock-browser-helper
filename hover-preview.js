(function(root){
  'use strict';
  function mount({container,tooltip,getItem,getKnown,fetchImage,fetchPage}){
    const core=root.GettyPluginCore,image=tooltip.querySelector('img'),label=tooltip.querySelector('.hover-preview-label'),status=tooltip.querySelector('[role="status"]');
    const cache=new Map();let active=null,serial=0,timer;
    const fingerprint=item=>item.urls.join('\n');
    function hide(){
      serial++;clearTimeout(timer);active?.controller.abort();active?.anchor.removeAttribute('aria-describedby');active=null;
      tooltip.hidden=true;image.hidden=true;image.removeAttribute('src');delete tooltip.dataset.key;
    }
    function position(){
      if(!active||tooltip.hidden)return;
      const anchor=active.anchor.getBoundingClientRect(),width=tooltip.offsetWidth,height=tooltip.offsetHeight;
      tooltip.style.left=Math.max(8,Math.min(anchor.left-width-12,root.innerWidth-width-8))+'px';
      tooltip.style.top=Math.max(8,Math.min((anchor.top+anchor.bottom-height)/2,root.innerHeight-height-8))+'px';
    }
    function display(entry){image.src=entry.objectUrl;image.hidden=false;status.hidden=true;position();}
    async function load(item,current,token){
      const signal=current.controller.signal;
      try{
        let sources=core.candidates([...item.urls,...(getKnown(item.key)?.candidates||[])],item.ref);
        if(!sources.length){
          const found=await core.discover(item.ref,{readOpenPages:async()=>getKnown(item.key)?[getKnown(item.key)]:[],fetchPage:url=>fetchPage(url,signal)});
          sources=found.candidates;
          if(!sources.length&&found.verification)throw Object.assign(Error('verification'),{previewMessage:'素材页需要验证，请点击链接手动完成。'});
        }
        // Use an already published small image; keep signed addresses unchanged.
        const source=sources.slice().sort((a,b)=>(core.declaredSize(a)||Infinity)-(core.declaredSize(b)||Infinity))[0];
        if(!source)throw Error('no thumbnail');
        const file=await fetchImage(source,item.ref,signal);
        if(signal.aborted||token!==serial||active!==current)return;
        const entry={fingerprint:fingerprint(item),objectUrl:URL.createObjectURL(file.blob)};
        if(cache.has(item.key))URL.revokeObjectURL(cache.get(item.key).objectUrl);
        cache.delete(item.key);cache.set(item.key,entry);
        while(cache.size>20){const key=cache.keys().next().value;URL.revokeObjectURL(cache.get(key).objectUrl);cache.delete(key);}
        display(entry);
      }catch(error){
        if(signal.aborted||token!==serial||active!==current)return;
        image.hidden=true;status.hidden=false;status.textContent=error.previewMessage||'预览暂不可用，仍可点击打开素材页。';position();
      }
    }
    function show(anchor){
      if(active?.anchor===anchor)return;
      hide();const item=getItem(anchor.dataset.previewKey);if(!item)return;
      const current={anchor,controller:new AbortController()};active=current;
      tooltip.dataset.key=item.key;anchor.setAttribute('aria-describedby',tooltip.id);
      label.textContent=`${item.ref.provider==='getty'?'Getty':'iStock'} · ${item.ref.id} · 原图试看`;
      image.hidden=true;status.hidden=false;status.textContent='正在加载试看图…';tooltip.hidden=false;position();
      const cached=cache.get(item.key);
      if(cached?.fingerprint===fingerprint(item)){display(cached);return;}
      const token=serial;timer=setTimeout(()=>load(item,current,token),160);
    }
    function target(event){const anchor=event.target.closest?.('a[data-preview-key]');return anchor&&container.contains(anchor)?anchor:null;}
    container.addEventListener('pointerover',event=>{if(event.pointerType==='touch')return;const anchor=target(event);if(anchor&&!anchor.contains(event.relatedTarget))show(anchor);});
    container.addEventListener('pointerout',event=>{const anchor=target(event);if(anchor&&active?.anchor===anchor&&!anchor.contains(event.relatedTarget))hide();});
    container.addEventListener('focusin',event=>{const anchor=target(event);if(anchor)show(anchor);});
    container.addEventListener('focusout',event=>{if(target(event)===active?.anchor)hide();});
    root.addEventListener('scroll',hide,true);root.addEventListener('resize',hide);
    root.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});
    image.addEventListener('load',position);
    return {refresh(){
      hide();for(const [key,entry] of cache){const item=getItem(key);if(!item||entry.fingerprint!==fingerprint(item)){URL.revokeObjectURL(entry.objectUrl);cache.delete(key);}}
    }};
  }
  root.GettyHoverPreview={mount};
})(globalThis);
