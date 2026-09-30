"""CPU speech engines with explicitly downloaded or uploaded persistent models."""
import gc
import io
import json
import os
import re
import shutil
import threading
import tempfile
import time
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import sherpa_onnx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from kokoro import KModel, KPipeline
from download import install

ROOT = Path(os.environ.get('FRAME_SPEECH_MODELS', '/models'))
ROOT.mkdir(parents=True, exist_ok=True)
CATALOG = {m['model']: m for m in json.loads(Path(__file__).with_name('catalog.json').read_text(encoding='utf-8'))}
ONNX = {'melo', 'piper'}
ONNX_FILES = {'melo': 'model.onnx', 'piper': 'en_US-libritts_r-medium.onnx'}
LOCK = threading.RLock()
CACHE = {}
DOWNLOADS = ROOT / '.downloads'
DOWNLOADS.mkdir(exist_ok=True)
JOBS = {}
for abandoned in DOWNLOADS.iterdir():
    marker = abandoned / 'FRAME-INSTALLING.json'
    if abandoned.is_dir() and not abandoned.is_symlink() and marker.is_file():
        try:
            if json.loads(marker.read_text(encoding='utf-8')).get('model') in CATALOG and abandoned.resolve().parent == DOWNLOADS.resolve():
                shutil.rmtree(abandoned)
        except (ValueError, OSError):
            pass
for state_file in DOWNLOADS.glob('*.json'):
    try:
        state = json.loads(state_file.read_text(encoding='utf-8'))
        if state.get('state') in ('downloading', 'extracting'):
            state.update(state='failed', error='下载被中断，请重试')
        JOBS[state_file.stem] = state
    except (ValueError, OSError):
        pass
torch.set_num_threads(2)
app = FastAPI(docs_url=None, redoc_url=None)

def directory(model):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', model):
        raise HTTPException(400, 'Invalid model id')
    folder = ROOT / model
    if folder.is_symlink():
        raise HTTPException(400, 'Symbolic model directories are not supported')
    return folder


def ready(model, folder):
    if model in ONNX:
        return (folder / ONNX_FILES[model]).is_file() and (folder / 'tokens.txt').is_file()
    return (folder / 'config.json').is_file() and (folder / 'model.pth').is_file() and any((folder / 'voices').glob('*.pt'))


def download_model(model):
    stage = None
    last_saved = 0
    def progress(received, total, phase):
        nonlocal last_saved
        with LOCK:
            JOBS[model] = {'state': phase, 'receivedBytes': received, 'totalBytes': total}
            if time.monotonic() - last_saved >= 0.5:
                (DOWNLOADS / (model + '.json')).write_text(json.dumps(JOBS[model]), encoding='utf-8')
                last_saved = time.monotonic()
    try:
        stage = Path(tempfile.mkdtemp(prefix=model + '-', dir=DOWNLOADS))
        (stage / 'FRAME-INSTALLING.json').write_text(json.dumps({'model': model}), encoding='utf-8')
        install(model, stage, progress)
        if not ready(model, stage):
            raise ValueError('下载的模型文件不完整')
        (stage / 'FRAME-INSTALLING.json').unlink()
        with LOCK:
            stage.rename(directory(model))
            JOBS[model] = {'state': 'installed'}
    except Exception as error:
        with LOCK:
            JOBS[model] = {'state': 'failed', 'error': str(error)[:500]}
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        with LOCK:
            (DOWNLOADS / (model + '.json')).write_text(json.dumps(JOBS[model]), encoding='utf-8')


@app.post('/models/{model}/download')
def download(model: str):
    if model not in CATALOG:
        raise HTTPException(400, '请选择推荐模型；自定义模型通过文件上传安装')
    with LOCK:
        if ready(model, directory(model)):
            return {'state': 'installed'}
        if JOBS.get(model, {}).get('state') in ('downloading', 'extracting'):
            return JOBS[model]
        if directory(model).exists():
            raise HTTPException(409, '请先移除不完整的模型再重试')
        JOBS[model] = {'state': 'downloading', 'receivedBytes': 0, 'totalBytes': 0}
        try:
            (DOWNLOADS / (model + '.json')).write_text(json.dumps(JOBS[model]), encoding='utf-8')
        except OSError as error:
            JOBS[model] = {'state': 'failed', 'error': str(error)[:500]}
            raise HTTPException(503, '无法写入模型目录，请检查磁盘空间与权限') from error
        threading.Thread(target=download_model, args=(model,), daemon=True).start()
        return JOBS[model]

@app.get('/healthz')
def health():
    return {'status': 'ok', 'engines': list(CATALOG), 'device': 'cpu'}

@app.get('/models')
def models():
    result = []
    for model in list(CATALOG) + sorted(p.name for p in ROOT.iterdir() if p.is_dir() and not p.is_symlink() and not p.name.startswith('.') and p.name not in CATALOG):
        folder = directory(model)
        if model in ONNX:
            weights = folder/ONNX_FILES[model]
            voices = [v['id'] for v in CATALOG[model]['voices']]
        else:
            voices = sorted(p.stem for p in (folder/'voices').glob('*.pt') if not p.is_symlink())
        installed = bool(ready(model, folder))
        result.append({'id': model, 'builtin': model in CATALOG, 'ready': installed, 'voices': voices,
                       'download': {'state': 'installed'} if installed else JOBS.get(model, {'state': 'missing'})})
    return result

@app.post('/models/{model}')
def create(model: str):
    if model in CATALOG:
        raise HTTPException(409, 'Built-in model is immutable')
    folder = directory(model)
    if folder.exists():
        raise HTTPException(409, 'Model already exists')
    (folder/'voices').mkdir(parents=True)
    return {'id': model}

@app.delete('/models/{model}')
def delete(model: str):
    with LOCK:
        if JOBS.get(model, {}).get('state') in ('downloading', 'extracting'):
            raise HTTPException(409, '请等待下载完成后再移除')
        folder = directory(model)
        if not folder.exists():
            raise HTTPException(404, 'Model not found')
        CACHE.pop(model, None)
        shutil.rmtree(folder)
        JOBS.pop(model, None)
        (DOWNLOADS / (model + '.json')).unlink(missing_ok=True)
    return {'ok': True}

@app.put('/models/{model}/file')
async def upload(model: str, path: str, request: Request):
    if model in CATALOG or not re.fullmatch(r'(config\.json|model\.pth|voices/[a-z][a-z0-9_]{0,79}\.pt)', path):
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
            json.loads(temporary.read_text(encoding='utf-8'))
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
    if not ready(body.model, folder):
        raise HTTPException(409, '请先在语音模型列表下载或上传完整模型')
    if body.model in ONNX:
        if not body.voice.isdecimal() or not 0 <= int(body.voice) < CATALOG[body.model].get('speakerCount', 1):
            raise HTTPException(400, 'Invalid speaker ID')
        with LOCK:
            if body.model not in CACHE:
                CACHE.clear()
                gc.collect()
                if body.model == 'piper':
                    os.environ['ESPEAK_DATA_PATH'] = str(folder / 'espeak-ng-data')
                config = sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                            model=str(folder/ONNX_FILES[body.model]), tokens=str(folder/'tokens.txt'),
                            lexicon=str(folder/'lexicon.txt') if body.model == 'melo' else '',
                            data_dir=str(folder/'espeak-ng-data') if body.model == 'piper' else ''),
                        num_threads=2, provider='cpu'),
                    rule_fsts=','.join(str(folder/f) for f in ['date.fst','number.fst','phone.fst'] if (folder/f).is_file()),
                    max_num_sentences=1)
                if not config.validate():
                    raise HTTPException(503, 'Built-in model files are incomplete')
                CACHE[body.model] = sherpa_onnx.OfflineTts(config)
            generation = sherpa_onnx.GenerationConfig()
            generation.sid = int(body.voice)
            generation.speed = body.speed
            audio = CACHE[body.model].generate(body.input, generation)
            if len(audio.samples) == 0:
                raise HTTPException(422, 'No speech generated')
            output = io.BytesIO()
            sf.write(output, audio.samples, audio.sample_rate, format='WAV', subtype='PCM_16')
            return Response(output.getvalue(), media_type='audio/wav')
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', body.voice):
        raise HTTPException(400, 'Invalid voice')
    voice = folder / 'voices' / (body.voice + '.pt')
    if not voice.is_file():
        raise HTTPException(404, 'Voice not installed')
    with LOCK:
        if body.model not in CACHE:
            # Retain one model at a time to bound CPU memory.
            CACHE.clear()
            gc.collect()
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
