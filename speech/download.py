from pathlib import Path
from huggingface_hub import hf_hub_download
import shutil
import hashlib
import json
import tarfile
import tempfile
import urllib.request
REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'
root = Path('/opt/builtin')
(root/'voices').mkdir(parents=True, exist_ok=True)
catalog = json.loads(Path('/opt/speech/catalog.json').read_text())
files = [('config.json','config.json'), ('kokoro-v1_0.pth','model.pth')]
files += [(f"voices/{v['id']}.pt", f"voices/{v['id']}.pt") for v in catalog[0]['voices']]
for source, target in files:
    shutil.copyfile(hf_hub_download('hexgrad/Kokoro-82M', source, revision=REVISION), root/target)
shutil.copyfile(hf_hub_download('hexgrad/Kokoro-82M', 'README.md', revision=REVISION), root/'MODEL-CARD.md')
shutil.copyfile('/opt/speech/LICENSE.kokoro', root/'LICENSE')
# Materialize Mandarin dictionaries during image build, not first user request.
from kokoro import KPipeline
pipeline = KPipeline(lang_code='z', repo_id='hexgrad/Kokoro-82M', model=False)
pipeline.g2p('你好，欢迎来到动画工作台。')

# Checksum-pinned conversion artifacts; retain the distributed model cards/licenses.
for name, digest in [
    ('vits-melo-tts-zh_en', 'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514'),
    ('vits-piper-en_US-libritts_r-medium', '10dc268f3e371696d721486123e2705a9fc1faa113491979fde4d88dba1f1b1c'),
]:
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary)/'model.tar.bz2'
        urllib.request.urlretrieve(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{name}.tar.bz2', archive)
        assert hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == digest, name
        with tarfile.open(archive) as tar:
            tar.extractall('/opt/builtin-onnx', filter='data')
        (Path('/opt/builtin-onnx')/name/'FRAME-SOURCE.json').write_text(json.dumps({'archive': name, 'sha256': digest}))
        if name.startswith('vits-piper-'):
            shutil.copyfile('/opt/speech/LICENSE.piper', Path('/opt/builtin-onnx')/name/'LICENSE')
