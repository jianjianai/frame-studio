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
  for (const [model, input, voice] of [
    ["builtin", "你好", "zf_xiaobei"],
    ["melo", "你好", "0"],
    ["piper", "Hello", "0"],
  ]) {
    const response = await fetch(speech.url + "/v1/audio/speech", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input, voice }), signal: AbortSignal.timeout(90000),
    });
    const wave = Buffer.from(await response.arrayBuffer());
    if (!response.ok || wave.toString("ascii", 0, 4) !== "RIFF" || wave.length < 1000)
      throw Error(`${model} speech check failed: ${response.status} ${wave.toString("utf8", 0, 400)}`);
    console.log(`${model} speech OK: ${wave.length} bytes`);
  }
} finally {
  await speech?.close();
  fs.rmSync(data, { recursive: true, force: true });
}
