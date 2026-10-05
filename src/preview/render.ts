import { installOffline } from "../engine/offline-session";
import { importWork, workSourceFromQuery } from "./load-work";

/**
 * Headless capture page used by the server for AI frame previews, storyboards
 * and video export. Exposes window.__FRAME_STUDIO__ (frame/capture/audioChunk).
 */
(window as unknown as { __FRAME_RENDER_ERRORS__: string[] }).__FRAME_RENDER_ERRORS__ = [];
const errors = (window as unknown as { __FRAME_RENDER_ERRORS__: string[] }).__FRAME_RENDER_ERRORS__;
addEventListener("error", (event) => errors.push(event.message));
addEventListener("unhandledrejection", (event) => errors.push(String(event.reason?.message ?? event.reason)));
try {
  await installOffline(await importWork(workSourceFromQuery()));
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  if (!document.querySelector('[role="alert"]')) {
    const alert = document.createElement("p");
    alert.role = "alert";
    alert.textContent = String(error);
    document.body.append(alert);
  }
}
