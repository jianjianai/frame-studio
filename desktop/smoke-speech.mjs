import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bundle = path.resolve(process.argv[2] || "");
if (!fs.existsSync(path.join(bundle, "server", "local-speech.mjs")))
  throw Error("Pass the complete Windows release bundle directory");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-speech-check-"));
const { startLocalSpeech } = await import(pathToFileURL(path.join(bundle, "server", "local-speech.mjs")));
let speech;
try {
  speech = await startLocalSpeech(data);
  const models = await (await fetch(speech.url + "/models")).json();
  if (models.length !== 3 || models.some((model) => model.ready)) throw Error("Fresh installations must not contain model weights");
  const response = await fetch(speech.url + "/v1/audio/speech", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "你好", model: "builtin", voice: "zf_xiaobei" }),
  });
  if (response.status !== 409) throw Error("Missing models must require explicit installation");
  console.log("Speech starts without weights; missing models require explicit download");
} finally {
  await speech?.close();
  fs.rmSync(data, { recursive: true, force: true });
}
