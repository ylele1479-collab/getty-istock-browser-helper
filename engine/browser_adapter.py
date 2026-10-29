"""Browser acquisition boundary around the original processing pipeline.

Acquisition, the unavailable Python thread executor and font-template loading are adapted. The original
repair, alignment, donor guards, OCR crops, residual checks and fallback are retained.
"""
import json
import re
from collections import OrderedDict
from contextlib import contextmanager
from copy import deepcopy
from urllib.parse import urlsplit
from pathlib import Path
from concurrent.futures import Future
import numpy as np
from js import engine_progress
from app import pipeline, output_guard, ocr_guard
from app.errors import InvalidUrlError, NoSourceFoundError
from app.urlparse_gt import identify, KIND_DIRECT_LINK

class ImmediateExecutor:
    def __init__(self,*args,**kwargs):pass
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def submit(self,fn,*args,**kwargs):
        result=Future()
        try:result.set_result(fn(*args,**kwargs))
        except BaseException as exc:result.set_exception(exc)
        return result

output_guard.ThreadPoolExecutor=ImmediateExecutor
# Pyodide is a single-thread worker. All original evidence crops are still evaluated.
ocr_guard._workers=1
ocr_guard._engines=[None]
ocr_guard._available=[0]
_original_text_lines=ocr_guard.text_lines
_OCR_CACHE_BYTES=16*1024*1024
_OCR_CACHE_ENTRIES=128
_ocr_cache=None
_ocr_cache_bytes=0

@contextmanager
def _ocr_job():
    """Reuse only identical OCR evidence within one serialized browser job."""
    global _ocr_cache,_ocr_cache_bytes
    _ocr_cache=OrderedDict();_ocr_cache_bytes=0
    try:
        yield
    finally:
        _ocr_cache=None;_ocr_cache_bytes=0

def _text_lines(rgb,enhance=False,**kwargs):
    global _ocr_cache_bytes
    engine_progress('本机 OCR 检查文字与残留水印…')
    # Unknown future OCR options bypass reuse rather than accidentally sharing
    # evidence produced with different settings. Cancellation still runs on hits.
    check=kwargs.get('check_cancelled')
    if check:check()
    if _ocr_cache is None or type(enhance) is not bool or set(kwargs)-{'check_cancelled'}:
        return _original_text_lines(rgb,enhance=enhance,**kwargs)
    array=np.asarray(rgb)
    if array.dtype.hasobject or array.nbytes>_OCR_CACHE_BYTES:
        return _original_text_lines(rgb,enhance=enhance,**kwargs)
    pixels=array.tobytes(order='C')
    key=(array.shape,array.dtype.str,enhance,pixels)
    if key in _ocr_cache:
        _ocr_cache.move_to_end(key)
        return deepcopy(_ocr_cache[key])
    lines=_original_text_lines(rgb,enhance=enhance,**kwargs)
    # None means the check was unavailable: retry it, never treat it as clean.
    if lines is None:return None
    while _ocr_cache and (_ocr_cache_bytes+len(pixels)>_OCR_CACHE_BYTES
                          or len(_ocr_cache)>=_OCR_CACHE_ENTRIES):
        old_key,_=_ocr_cache.popitem(last=False)
        _ocr_cache_bytes-=len(old_key[3])
    _ocr_cache[key]=deepcopy(lines);_ocr_cache_bytes+=len(pixels)
    return deepcopy(lines)
ocr_guard.text_lines=_text_lines
import app.repair as repair
import app.wide_overlay as wide_overlay
# The original function renders Arial glyph edges via a Windows font path.
# Load its exact build-time arrays instead; retain the original matching and
# fail-closed donor checks without shipping a font or requiring installation.
with np.load('/engine/brand-edge-templates.npz',allow_pickle=False) as rendered:
    _brand_templates=[rendered[f'template_{i}'].copy() for i in range(7)]
wide_overlay._brand_edge_templates=lambda:_brand_templates
repair.text_lines=_text_lines
if hasattr(wide_overlay,'text_lines'):wide_overlay.text_lines=_text_lines

def acquire_local(url,timeout,**kwargs):
    engine_progress('核验同素材图源与真实像素…')
    parsed=urlsplit(url)
    if (parsed.scheme=='https' and parsed.hostname=='short.askingtips.com'
            and parsed.path.startswith('/uploads/') and not parsed.query
            and re.search(r'\.(jpg|jpeg|png|webp)$',parsed.path,re.I)):
        candidates=json.loads(Path('/job/candidates.json').read_text())
        if len(candidates)!=1 or candidates[0]['url']!=url:
            raise InvalidUrlError('第三方返回图片请单独预览，不与其他图源融合。')
        data=Path(candidates[0]['path']).read_bytes();info=pipeline._verify_image(data)
        images=pipeline.AcquiredImages();images.primary=(data,info,'third_party',url)
        images.append(images.primary);images.source_via[url]='imported'
        return 'imported',images,['第三方返回图片，请通过预览核对水印和画质。']
    ref=identify(url)
    if not ref.asset_id:raise InvalidUrlError('无法确认输入图片的素材编号。')
    images=pipeline.AcquiredImages();notes=[]
    items=json.loads(Path('/job/candidates.json').read_text())
    explicit=json.loads(Path('/job/extra-sources.json').read_text())
    # As in the original acquisition flow, obtain the native-provider reference
    # before considering explicitly supplied cross-provider image bytes.
    items.sort(key=lambda item:identify(item['url']).provider!=ref.provider)
    for item in items:
        address=item['url'];candidate=identify(address)
        cross=candidate.provider!=ref.provider
        allowed_cross=(ref.provider=='istock' and candidate.provider=='getty' and address in explicit)
        if (candidate.kind!=KIND_DIRECT_LINK or candidate.asset_id!=ref.asset_id or (cross and not allowed_cross)):
            images.candidate_checks.append({'url':address,'error':'PHOTO_MISMATCH'})
            continue
        try:
            data=Path(item['path']).read_bytes()
            info=pipeline._verify_image(data)
            if not info.is_image:raise ValueError('图片无法完整解码')
            if cross:
                reference=images.primary or next((v for v in images if identify(v[3]).provider==ref.provider),None)
                identity=pipeline.match_same_photo(reference[0],data) if reference else {'verified':False}
                if not identity['verified']:
                    images.candidate_checks.append({'url':address,'error':'PHOTO_MISMATCH','identity':identity})
                    notes.append('另一网站的同编号图片未通过同照片核对，未用作高清图源。')
                    continue
            value=(data,info,candidate.watermark_param,address)
            images.append(value);images.source_via[address]=item.get('via','browser')
            images.candidate_checks.append({'url':address,'width':info.width,'height':info.height})
            if address==url:images.primary=value
        except Exception as exc:
            images.candidate_checks.append({'url':address,'error':getattr(exc,'code','INVALID_IMAGE')})
    if not images:raise NoSourceFoundError('没有取得可解码且素材编号匹配的图片。')
    if ref.kind==KIND_DIRECT_LINK and images.primary is None:
        raise NoSourceFoundError('输入原图未能取得，未用其他候选替代输入原图。')
    return ref.asset_id,images,notes

pipeline.acquire_images=acquire_local

def process(url,allow_repair):
    engine_progress('运行原版对齐、供图保护与局部融合…')
    with _ocr_job():
        result=pipeline.run_job(url,allow_repair=bool(allow_repair),discovery_mode='direct_only')
    Path('/job/output.bin').write_bytes(result.image_bytes)
    Path('/job/source.bin').write_bytes(result.original_bytes)
    Path('/job/comparison.bin').write_bytes(result.comparison_bytes)
    return json.dumps({'ok':result.ok,'payload':result.payload,'filename':result.filename},ensure_ascii=False)

def diagnostic_ocr(path):
    from PIL import Image
    import cv2
    if ocr_guard._engines[0] is None:
        ocr_guard._engines[0]=ocr_guard._create_engine()
    if ocr_guard._engines[0] is None:raise RuntimeError('Bundled original OCR models did not initialize')
    image=np.asarray(Image.open(path).convert('RGB'))
    image=cv2.resize(image,None,fx=3,fy=3,interpolation=cv2.INTER_CUBIC)
    output=ocr_guard._engines[0](image[...,::-1].copy(),use_cls=False,box_thresh=.3)
    lines=[] if output.boxes is None else [(float(box[:,0].min()/3),float(box[:,1].min()/3),
        float(box[:,0].max()/3),float(box[:,1].max()/3),str(word),float(score))
        for box,word,score in zip(output.boxes,output.txts,output.scores)]
    return json.dumps(lines,ensure_ascii=False)
