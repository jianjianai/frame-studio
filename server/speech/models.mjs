/**
 * Recommended local TTS models (sherpa-onnx). Nothing is bundled: each model
 * is downloaded on demand into <FRAME_HOME>/models/speech/<id>/.
 */
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";

export const SPEECH_MODELS = [
  {
    id: "kokoro-multi-lang-v1_1-int8",
    name: "Kokoro 多语言 v1.1",
    description: "中英文混读，103 个声音，音质自然。推荐首选。",
    languages: ["中文", "English"],
    type: "kokoro",
    archive: RELEASE + "kokoro-int8-multi-lang-v1_1.tar.bz2",
    size: 147_000_000,
    license: "Apache-2.0",
    homepage: "https://huggingface.co/hexgrad/Kokoro-82M",
  },
  {
    id: "vits-melo-tts-zh_en",
    name: "MeloTTS 中英",
    description: "中文为主，可夹杂英文单词，单一女声。",
    languages: ["中文", "English"],
    type: "vits",
    archive: RELEASE + "vits-melo-tts-zh_en.tar.bz2",
    size: 167_000_000,
    license: "MIT",
    homepage: "https://github.com/myshell-ai/MeloTTS",
  },
  {
    id: "vits-piper-zh_CN-xiao_ya-medium-int8",
    name: "Piper 小雅（中文女声）",
    description: "体积很小（14 MB），速度快，适合旁白草稿。",
    languages: ["中文"],
    type: "vits",
    archive: RELEASE + "vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2",
    size: 14_000_000,
    license: "见模型 MODEL_CARD",
    homepage: "https://github.com/rhasspy/piper",
  },
  {
    id: "vits-piper-zh_CN-chaowen-medium-int8",
    name: "Piper 超文（中文男声）",
    description: "体积很小（14 MB）的中文男声。",
    languages: ["中文"],
    type: "vits",
    archive: RELEASE + "vits-piper-zh_CN-chaowen-medium-int8.tar.bz2",
    size: 14_000_000,
    license: "见模型 MODEL_CARD",
    homepage: "https://github.com/rhasspy/piper",
  },
  {
    id: "vits-piper-en_US-libritts_r-medium-int8",
    name: "Piper LibriTTS（英文多声音）",
    description: "904 个英文声音，体积 23 MB。",
    languages: ["English"],
    type: "vits",
    archive: RELEASE + "vits-piper-en_US-libritts_r-medium-int8.tar.bz2",
    size: 23_000_000,
    license: "见模型 MODEL_CARD",
    homepage: "https://github.com/rhasspy/piper",
  },
  {
    id: "kitten-nano-en-v0_8-int8",
    name: "KittenTTS Nano（英文）",
    description: "极小的英文模型（31 MB），8 个声音。",
    languages: ["English"],
    type: "kitten",
    archive: RELEASE + "kitten-nano-en-v0_8-int8.tar.bz2",
    size: 31_000_000,
    license: "Apache-2.0",
    homepage: "https://github.com/KittenML/KittenTTS",
  },
];

const ASR_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/";

/** Speech recognition models for voice input in the chat (sherpa-onnx), downloaded on demand like the voices. */
export const RECOGNITION_MODELS = [
  {
    id: "sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    name: "SenseVoice Small",
    description: "中文、英文、粤语、日语、韩语，可以混着说；自带标点，数字写成阿拉伯数字。推荐。",
    languages: ["中文", "English", "粤语", "日本語", "한국어"],
    type: "sense-voice",
    archive: ASR_RELEASE + "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    size: 163_000_000,
    license: "FunASR 模型许可",
    licenseUrl: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
    homepage: "https://github.com/FunAudioLLM/SenseVoice",
  },
];

/** Voice activity detection: cuts what is said into sentences at the pauses. One small file, fetched when first needed. */
export const VAD_MODEL = {
  id: "silero-vad",
  file: "silero_vad.onnx",
  url: ASR_RELEASE + "silero_vad.onnx",
  license: "MIT",
  homepage: "https://github.com/snakers4/silero-vad",
};
