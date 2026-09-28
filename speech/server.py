"""CPU-only Kokoro service. Uploaded weights are loaded with weights_only=True."""
import io
import json
import re
import shutil
import threading
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from kokoro import KModel, KPipeline

ROOT = Path('/models')
ROOT.mkdir(exist_ok=True)
BUILTIN = Path('/opt/builtin')
LOCK = threading.RLock()
CACHE = {}
torch.set_num_threads(2)
app = FastAPI(docs_url=None, redoc_url=None)

def directory(model):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', model):
        raise HTTPException(400, 'Invalid model id')
    return BUILTIN if model == 'builtin' else ROOT / model

@app.get('/healthz')
def health():
    return {'status': 'ok', 'engine': 'kokoro', 'device': 'cpu'}

@app.get('/models')
def models():
    result = []
    for model in ['builtin'] + sorted(p.name for p in ROOT.iterdir() if p.is_dir() and not p.is_symlink()):
        folder = directory(model)
        result.append({'id': model, 'ready': (folder/'config.json').is_file() and (folder/'model.pth').is_file(),
                       'voices': sorted(p.stem for p in (folder/'voices').glob('*.pt'))})
    return result

@app.post('/models/{model}')
def create(model: str):
    if model == 'builtin':
        raise HTTPException(409, 'Built-in model is immutable')
    folder = directory(model)
    if folder.exists():
        raise HTTPException(409, 'Model already exists')
    (folder/'voices').mkdir(parents=True)
    return {'id': model}

@app.delete('/models/{model}')
def delete(model: str):
    if model == 'builtin':
        raise HTTPException(409, 'Built-in model is immutable')
    with LOCK:
        folder = directory(model)
        if not folder.exists():
            raise HTTPException(404, 'Model not found')
        CACHE.pop(model, None)
        shutil.rmtree(folder)
    return {'ok': True}

@app.put('/models/{model}/file')
async def upload(model: str, path: str, request: Request):
    if model == 'builtin' or not re.fullmatch(r'(config\.json|model\.pth|voices/[a-z][a-z0-9_]{0,79}\.pt)', path):
        raise HTTPException(400, 'Allowed: config.json, model.pth, voices/name.pt')
    folder = directory(model)
    if not folder.is_dir():
        raise HTTPException(404, 'Create the model first')
    target = folder / path
    temporary = target.with_suffix(target.suffix + '.upload')
    size = 0
    try:
        with temporary.open('xb') as stream:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 1024 * 1024 * 1024:
                    raise HTTPException(413, 'Model file exceeds 1 GiB')
                stream.write(chunk)
        if path == 'config.json':
            if size > 1024 * 1024:
                raise HTTPException(413, 'Configuration too large')
            json.loads(temporary.read_text())
        else:
            torch.load(str(temporary), map_location='cpu', weights_only=True)
        with LOCK:
            temporary.replace(target)
            CACHE.pop(model, None)
    finally:
        temporary.unlink(missing_ok=True)
    return {'ok': True, 'bytes': size}

class Speech(BaseModel):
    input: str = Field(min_length=1, max_length=4000)
    model: str = 'builtin'
    voice: str = 'zf_xiaobei'
    speed: float = Field(default=1, ge=0.5, le=2)
    response_format: str = 'wav'

@app.post('/v1/audio/speech')
def speak(body: Speech):
    if body.response_format != 'wav':
        raise HTTPException(400, 'This engine produces WAV')
    folder = directory(body.model)
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', body.voice):
        raise HTTPException(400, 'Invalid voice')
    voice = folder / 'voices' / (body.voice + '.pt')
    if not voice.is_file():
        raise HTTPException(404, 'Voice not installed')
    with LOCK:
        if body.model not in CACHE:
            # Retain one model at a time to bound CPU memory.
            CACHE.clear()
            model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(folder/'config.json'), model=str(folder/'model.pth')).eval().to('cpu')
            CACHE[body.model] = KPipeline(lang_code='z', repo_id='hexgrad/Kokoro-82M', model=model, device='cpu')
        pipeline = CACHE[body.model]
        tensors = torch.load(str(voice), map_location='cpu', weights_only=True)
        # Bound Chinese chunks to avoid the upstream phoneme truncation path.
        chunks = [body.input[i:i+80] for i in range(0, len(body.input), 80)]
        samples = [audio.numpy() for chunk in chunks for _, _, audio in pipeline(chunk, voice=tensors, speed=body.speed) if audio is not None]
        if not samples:
            raise HTTPException(422, 'No speech generated')
        output = io.BytesIO()
        sf.write(output, np.concatenate(samples), 24000, format='WAV', subtype='PCM_16')
        return Response(output.getvalue(), media_type='audio/wav')
