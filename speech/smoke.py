import io
import json
import urllib.request
import soundfile as sf

request = urllib.request.Request('http://127.0.0.1:8000/v1/audio/speech',
    data=json.dumps({'input': '你好，这是动画工作台的中文语音测试。', 'voice': 'zf_xiaobei'}).encode(),
    headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=180) as response:
    content = response.read()
audio, sample_rate = sf.read(io.BytesIO(content))
assert sample_rate == 24000 and len(audio) > 24000 and abs(audio).max() > 0.01
print(json.dumps({'bytes': len(content), 'sampleRate': sample_rate, 'seconds': len(audio)/sample_rate, 'peak': float(abs(audio).max())}))
