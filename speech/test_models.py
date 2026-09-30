import asyncio
import io
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ['FRAME_SPEECH_MODELS'] = tempfile.mkdtemp(prefix='frame-model-import-')
import server
import download


class Models(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='frame-model-test-')
        server.ROOT = Path(self.temporary.name)
        server.DOWNLOADS = server.ROOT / '.downloads'
        server.DOWNLOADS.mkdir()
        server.JOBS.clear()

    def tearDown(self):
        self.temporary.cleanup()

    def test_empty_start_and_custom_slot(self):
        self.assertEqual(len(server.models()), 3)
        self.assertTrue(all(not m['ready'] and m['download']['state'] == 'missing' for m in server.models()))
        with self.assertRaises(server.HTTPException) as missing:
            server.speak(server.Speech(input='你好'))
        self.assertEqual(missing.exception.status_code, 409)
        server.create('custom')
        config = b'{}'
        tensor = io.BytesIO()
        server.torch.save(server.torch.zeros(2), tensor)
        class Request:
            def __init__(self, content): self.content = content
            async def stream(self): yield self.content
        for name, content in [('config.json', config), ('model.pth', tensor.getvalue()), ('voices/test.pt', tensor.getvalue())]:
            asyncio.run(server.upload('custom', name, Request(content)))
        self.assertTrue(next(m for m in server.models() if m['id'] == 'custom')['ready'])

    def test_failed_download_retry_and_remove(self):
        with patch.object(server, 'install', side_effect=ValueError('checksum failed')):
            server.download_model('piper')
        self.assertEqual(server.JOBS['piper']['state'], 'failed')
        self.assertFalse(server.directory('piper').exists())
        def installer(model, stage, progress):
            progress(10, 20, 'downloading')
            (stage / 'tokens.txt').write_text('tokens')
            (stage / server.ONNX_FILES[model]).write_bytes(b'model')
        with patch.object(server, 'install', installer):
            server.download('piper')
            for _ in range(100):
                if server.JOBS['piper']['state'] == 'installed': break
                time.sleep(.01)
        self.assertTrue(server.ready('piper', server.directory('piper')))
        server.delete('piper')
        self.assertFalse(server.directory('piper').exists())

    def test_checksum_failure_removes_temporary_download(self):
        target = server.ROOT / 'bad.bin'
        source = server.ROOT / 'source.bin'
        source.write_bytes(b'wrong data')
        with patch.object(download.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                download.fetch(source.as_uri(), target, '0' * 64, lambda *args: None)
        self.assertFalse(target.exists())


if __name__ == '__main__':
    try: unittest.main()
    finally:
        import shutil
        shutil.rmtree(os.environ['FRAME_SPEECH_MODELS'], ignore_errors=True)
