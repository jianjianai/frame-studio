import { installOffline } from "../engine/offline-session";
import { importWork, workSourceFromQuery } from "./load-work";

/**
 * Headless capture page used by the server for AI frame previews, contact sheets
 * and video export. Exposes window.__FRAME_STUDIO__ (frame/capture/audioChunk).
 */
(window as unknown as { __FRAME_RENDER_ERRORS__: string[] }).__FRAME_RENDER_ERRORS__ = [];
const errors = (window as unknown as { __FRAME_RENDER_ERRORS__: string[] }).__FRAME_RENDER_ERRORS__;
// With the stack: the server maps it back to file:line:column in the work and its library code.
const describe = (error: unknown) => (error instanceof Error ? error.stack || error.message : String(error));
addEventListener("error", (event) => errors.push(event.error ? describe(event.error) : event.message));
addEventListener("unhandledrejection", (event) => errors.push(describe(event.reason)));
try {
  await installOffline(await importWork(workSourceFromQuery()));
} catch (error) {
  errors.push(describe(error));
  if (!document.querySelector('[role="alert"]')) {
    const alert = document.createElement("p");
    alert.role = "alert";
    alert.textContent = String(error);
    document.body.append(alert);
  }
}
