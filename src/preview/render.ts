import { installOffline } from "../engine/offline-session";
import { importWork, workSourceFromQuery } from "./load-work";
import { reportToStudio } from "./report";

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
reportToStudio();
const source = workSourceFromQuery();
let materials: number | undefined;
try {
  await installOffline(await importWork(source));
  // Drawn for the AI in a studio page (web/lib/gpu-render.ts), on that page's thread: between two
  // frames the thread is free for a moment, so a preview playing there draws when its frame is due
  // (nothing waits for it).
  const studio = window.__FRAME_STUDIO__;
  if (window.name === "frame-ai-render" && studio) {
    const frame = studio.frame;
    studio.frame = async (time, subtitles) => {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
      return frame(time, subtitles);
    };
  }
  // After an edit the server has the page take the work again in place, as the stage does: a new
  // page loads everything again (over the network, for a page in the user's browser).
  if (studio)
    studio.update = async (timestamp, changed) => {
      if (changed) materials = changed;
      return studio.replace!(await importWork(source, timestamp, materials));
    };
} catch (error) {
  errors.push(describe(error));
  if (!document.querySelector('[role="alert"]')) {
    const alert = document.createElement("p");
    alert.role = "alert";
    alert.textContent = String(error);
    document.body.append(alert);
  }
}
