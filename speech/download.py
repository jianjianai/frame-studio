from pathlib import Path
from huggingface_hub import hf_hub_download
import shutil
root = Path('/opt/builtin')
(root/'voices').mkdir(parents=True, exist_ok=True)
for source, target in [('config.json','config.json'), ('kokoro-v1_0.pth','model.pth'), ('voices/zf_xiaobei.pt','voices/zf_xiaobei.pt'), ('voices/zf_xiaoni.pt','voices/zf_xiaoni.pt'), ('voices/zm_yunxi.pt','voices/zm_yunxi.pt')]:
    shutil.copyfile(hf_hub_download('hexgrad/Kokoro-82M', source), root/target)
# Materialize Mandarin dictionaries during image build, not first user request.
from kokoro import KPipeline
pipeline = KPipeline(lang_code='z', repo_id='hexgrad/Kokoro-82M', model=False)
pipeline.g2p('你好，欢迎来到动画工作台。')
