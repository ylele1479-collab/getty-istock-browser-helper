"""The small synchronous ORT API used by the unchanged RapidOCR code.

Inference runs in a separate local WebAssembly worker. No model or runtime is fetched remotely.
"""
import json
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from js import engine_infer

__version__='1.23.2'
class SessionOptions:pass
class GraphOptimizationLevel:
    ORT_ENABLE_ALL=99
def get_available_providers():return ['CPUExecutionProvider']
def get_device():return 'CPU'

class InferenceSession:
    def __init__(self,path,sess_options=None,providers=None,**kwargs):
        self.model=Path(path).name
        self.meta=json.loads(Path('/engine/models.json').read_text())[self.model]
    def get_inputs(self):return [SimpleNamespace(**v) for v in self.meta['inputs']]
    def get_outputs(self):return [SimpleNamespace(**v) for v in self.meta['outputs']]
    def get_modelmeta(self):return SimpleNamespace(custom_metadata_map=self.meta['custom_metadata_map'])
    def get_providers(self):return get_available_providers()
    def run(self,output_names,input_feed,**kwargs):
        if len(input_feed)!=1:raise ValueError('Only the original single-input OCR models are supported')
        name,array=next(iter(input_feed.items()))
        value=np.ascontiguousarray(array,dtype=np.float32)
        result=engine_infer(self.model,name,json.dumps(list(value.shape)),value.tobytes())
        # Copy before the next synchronous inference reuses the shared response buffer.
        output=np.frombuffer(bytes(result.data.to_py()),dtype=np.float32).copy()
        return [output.reshape(json.loads(str(result.shape)))]
