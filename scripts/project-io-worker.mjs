import { parentPort } from "node:worker_threads";
import { ProjectService } from "./project-service.mjs";
import { FrameError } from "./mcp/workspace.mjs";
import { captureInput, inputDigestMetrics } from "./production-input.mjs";
import { visualEdit } from "./visual-service.mjs";
import { audioEdit } from "./audio-service.mjs";

parentPort.on("message", ({ root, options, operation, arguments: args }) => {
  try {
    let value;
    if (operation === "captureInput") {
      const snapshot = captureInput(root, ...args);
      value = { root: snapshot.root, manifest: snapshot.manifest };
    } else {
      const workspace = new ProjectService(root, options);
      value =
        operation === "visualEdit"
          ? visualEdit(workspace, ...args)
          : operation === "audioEdit"
            ? audioEdit(workspace, ...args)
            : workspace[operation](...args);
    }
    parentPort.postMessage({ value, metrics: inputDigestMetrics() });
  } catch (error) {
    parentPort.postMessage({
      metrics: inputDigestMetrics(),
      error: {
        frame: error instanceof FrameError,
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }
});
