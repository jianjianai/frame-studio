// Puts the voice input models into a folder at image build time (deploy/Dockerfile), laid out
// like downloaded ones, so the chat's microphone works without a download. Point
// FRAME_SPEECH_MODELS at the folder. Usage: node server/speech/bundle.mjs <dir>
import path from "node:path";
import { RECOGNITION_MODELS, VAD_MODEL } from "./models.mjs";
import { fetchFile, fetchModel } from "./download.mjs";

const dir = path.resolve(process.argv[2] || "models/speech");
const [model] = RECOGNITION_MODELS;
await fetchModel(model, path.join(dir, model.id));
await fetchFile(VAD_MODEL.url, path.join(dir, VAD_MODEL.id, VAD_MODEL.file));
console.log(`${model.name} and ${VAD_MODEL.file} in ${dir}`);
