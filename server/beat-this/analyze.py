"""
Beats and downbeats of music with Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024;
https://github.com/CPJKU/beat_this, MIT license for code and weights). FRAME runs this for
the preview_audio tool (server/audio-analysis.mjs).

stdin: mono float32 PCM; argv[1]: its sample rate.
stdout: {"beats": [...], "downbeats": [...]} in seconds.
The model (FRAME_BEAT_MODEL, default final0) comes from TORCH_HOME and is downloaded there
on first use.
"""
import contextlib
import json
import os
import sys

import numpy as np
import torch
from beat_this.inference import Audio2Beats


def main():
    rate = int(sys.argv[1])
    signal = np.frombuffer(sys.stdin.buffer.read(), dtype=np.float32)
    # Measured on 8 cores: 4 threads is fastest; more only contend with the rest of the studio.
    torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
    # torch.hub announces the first download on stdout; stdout carries only the result.
    with contextlib.redirect_stdout(sys.stderr):
        tracker = Audio2Beats(checkpoint_path=os.environ.get("FRAME_BEAT_MODEL", "final0"), device="cpu")
        with torch.inference_mode():
            beats, downbeats = tracker(signal, rate)
    json.dump({"beats": [round(float(t), 3) for t in beats], "downbeats": [round(float(t), 3) for t in downbeats]}, sys.stdout)


if __name__ == "__main__":
    main()
