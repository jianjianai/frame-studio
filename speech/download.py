"""Explicit, checksum-pinned model installation; importing never downloads."""
import hashlib
import json
import shutil
import tarfile
import time
import urllib.request
from pathlib import Path

SOURCES = json.loads(Path(__file__).with_name('model-sources.json').read_text(encoding='utf-8-sig'))


def fetch(url, target, digest, progress, offset=0, total=0):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'FRAME-Studio-model-installer'})
            with urllib.request.urlopen(request, timeout=60) as response, target.open('wb') as output:
                length = int(response.headers.get('Content-Length', 0))
                received = 0
                checksum = hashlib.sha256()
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    checksum.update(chunk)
                    received += len(chunk)
                    progress(offset + received, total or length, 'downloading')
            if checksum.hexdigest() != digest:
                raise ValueError('Model SHA-256 mismatch: ' + target.name)
            return received
        except Exception:
            target.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def install(model, stage, progress):
    spec = SOURCES[model]
    if model == 'builtin':
        (stage / 'voices').mkdir(parents=True)
        total = sum(f['bytes'] for f in spec['files'])
        done = 0
        for item in spec['files']:
            url = f"https://huggingface.co/{spec['repository']}/resolve/{spec['revision']}/{item['source']}"
            done += fetch(url, stage / item['target'], item['sha256'], progress, done, total)
        shutil.copyfile(Path(__file__).with_name('LICENSE.kokoro'), stage / 'LICENSE')
    else:
        name = spec['archive']
        archive = stage / 'model.tar.bz2'
        fetch(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{name}.tar.bz2',
              archive, spec['sha256'], progress)
        progress(0, 0, 'extracting')
        with tarfile.open(archive) as tar:
            tar.extractall(stage, filter='data')
        archive.unlink()
        extracted = stage / name
        for item in list(extracted.iterdir()):
            item.rename(stage / item.name)
        extracted.rmdir()
        if model == 'piper':
            shutil.copyfile(Path(__file__).with_name('LICENSE.piper'), stage / 'LICENSE')
    (stage / 'FRAME-SOURCE.json').write_text(json.dumps(spec), encoding='utf-8')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('model', choices=list(SOURCES))
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=False)
    install(args.model, args.destination, lambda done, total, phase: print(phase, done, total, flush=True))
