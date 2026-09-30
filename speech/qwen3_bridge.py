"""Optional Frame protocol bridge for pre-installed Qwen3-TTS CustomVoice weights.

Not part of the built-in speech service. Install dependencies and weights manually
in an isolated environment; run only on a trusted network. No cloning endpoints.
"""
import argparse
import io
import threading
from pathlib import Path


def create_app(model, model_id, instructions_supported):
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import Response
    from pydantic import BaseModel, ConfigDict, Field
    import soundfile as sf

    app = FastAPI(title="Frame Qwen3-TTS bridge")
    inference_lock = threading.Lock()

    class Speech(BaseModel):
        model_config = ConfigDict(extra="forbid")
        model: str
        input: str = Field(min_length=1, max_length=4096)
        voice: str
        language: str = "Auto"
        instructions: str | None = Field(default=None, max_length=2000)
        response_format: str = "wav"

    @app.get("/v1/voices")
    def voices():
        return {"voices": [{"id": s, "name": s} for s in model.get_supported_speakers()],
                "models": [{"id": model_id, "languages": model.get_supported_languages()}]}

    @app.post("/v1/audio/speech")
    def speech(request: Speech):
        if request.model != model_id or request.response_format != "wav":
            raise HTTPException(400, "Model or output format is unsupported")
        speakers = {s.lower() for s in model.get_supported_speakers()}
        languages = {s.lower() for s in model.get_supported_languages()} | {"auto"}
        if request.voice.lower() not in speakers or request.language.lower() not in languages:
            raise HTTPException(400, "Speaker or language is unsupported")
        if request.instructions and not instructions_supported:
            raise HTTPException(400, "This model does not support instructions")
        if not inference_lock.acquire(blocking=False):
            raise HTTPException(429, "Inference busy", headers={"Retry-After": "5"})
        try:
            kwargs = {"text": request.input, "speaker": request.voice, "language": request.language}
            if request.instructions:
                kwargs["instruct"] = request.instructions
            wavs, sample_rate = model.generate_custom_voice(**kwargs)
            out = io.BytesIO()
            sf.write(out, wavs[0], sample_rate, format="WAV", subtype="PCM_16")
            return Response(out.getvalue(), media_type="audio/wav")
        except HTTPException:
            raise
        except Exception:
            # Never expose provider exceptions, prompts, credentials or filesystem paths.
            raise HTTPException(500, "Qwen inference failed") from None
        finally:
            inference_lock.release()

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, help="Pre-installed local CustomVoice model directory")
    parser.add_argument("--model-id", choices=["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"], required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8012)
    args = parser.parse_args()
    if not Path(args.weights).is_dir():
        parser.error("--weights must be an existing local model directory")
    import torch
    import uvicorn
    from qwen_tts import Qwen3TTSModel
    model = Qwen3TTSModel.from_pretrained(args.weights, device_map=args.device, dtype=torch.bfloat16 if args.device.startswith("cuda") else torch.float32)
    uvicorn.run(create_app(model, args.model_id, "1.7B" in args.model_id), host=args.host, port=args.port, access_log=False)
