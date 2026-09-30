import fs from "node:fs/promises";
import path from "node:path";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";

/** Resolve a mutable deployment tag once; the task itself always runs an immutable image ID. */
export async function executionRuntime({ data, task, command }) {
  if (process.env.FRAME_LOCAL_MODE === "1")
    return { ...(await runtimeIdentity()), image: null, requestedImage: null,
      imageRevision: null, imageDigests: [], local: true,
      tool: task.kind === "agent" ? { provider: task.input.provider, version: null, source: "system" } : null };
  const requestedImage = process.env.FRAME_EXECUTOR_IMAGE || "frame-studio:local";
  const image = JSON.parse(await command("docker", ["image", "inspect", "--format", "{{json .}}", requestedImage], { timeout: 30000, max: 1024 * 1024 }));
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw Error("Executor image did not resolve to an immutable ID");
  let tool = null;
  if (task.kind === "agent") {
    const provider = task.input.provider;
    let version = null;
    try { version = (await fs.readFile(path.join(data, "tools", provider, "current"), "utf8")).trim(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (version !== null && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error("Invalid selected tool version");
    tool = { provider, version, source: version ? "installed" : "image" };
  }
  return { ...(await runtimeIdentity()), image: image.Id, requestedImage,
    imageRevision: image.Config?.Labels?.["org.opencontainers.image.revision"] || null,
    imageDigests: image.RepoDigests || [], tool };
}
