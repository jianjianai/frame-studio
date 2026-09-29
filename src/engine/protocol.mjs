/** Increment only for a breaking scene/audio contract, not a platform feature release. */
export const ENGINE_PROTOCOL_VERSION = 1;
/** @param {{engineProtocol?: number}} project */
export function assertEngineProtocol(project) {
  if ((project.engineProtocol ?? 1) !== ENGINE_PROTOCOL_VERSION)
    throw new Error("Unsupported work engine protocol: " + project.engineProtocol);
}
