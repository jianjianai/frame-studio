import { runtimeIdentity } from "../scripts/runtime-identity.mjs";

/** Resolve a mutable deployment tag once; the task itself always runs an immutable image ID. */
export async function executionRuntime({ command }) {
  if (process.env.FRAME_LOCAL_MODE === "1")
    return { ...(await runtimeIdentity()), image: null, requestedImage: null,
      imageRevision: null, imageDigests: [], local: true,
      tool: null };
  const requestedImage = process.env.FRAME_EXECUTOR_IMAGE || "frame-studio:local";
  const image = JSON.parse(await command("docker", ["image", "inspect", "--format", "{{json .}}", requestedImage], { timeout: 30000, max: 1024 * 1024 }));
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw Error("Executor image did not resolve to an immutable ID");
  return { ...(await runtimeIdentity()), image: image.Id, requestedImage,
    imageRevision: image.Config?.Labels?.["org.opencontainers.image.revision"] || null,
    imageDigests: image.RepoDigests || [], tool: null };
}
