import { parentPort } from "node:worker_threads";
import { ProjectService } from "./project-service.mjs";
import { FrameError, fail } from "./mcp/workspace.mjs";
import { captureInput, inputDigestMetrics } from "./production-input.mjs";
import { visualEdit } from "./visual-service.mjs";
import { audioEdit } from "./audio-service.mjs";
import { inspectProjectScope } from "./project-scope-report.mjs";

function checkProject(workspace, id, { base } = {}) {
  const structure = workspace.check(id);
  let scope;
  try {
    scope = inspectProjectScope(workspace.root, id, { base });
  } catch (error) {
    fail("SCOPE_CHECK_FAILED", "Git scope inspection could not run.", {
      structure,
      reason: error.message,
    });
  }
  return {
    status: "completed",
    passed: structure.passed && scope.passed,
    projectPassed: structure.passed,
    scopeVerified: scope.passed,
    structure,
    scope,
    nextAction: !structure.passed
      ? "Fix the structural errors before rendering."
      : scope.nextAction,
  };
}

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
            : operation === "checkProject"
              ? checkProject(workspace, ...args)
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
