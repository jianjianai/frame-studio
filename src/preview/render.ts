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
if (window.parent !== window) reportToStudio();
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

/**
 * Drawn for the AI in a studio page of the user's browser (web/lib/gpu-render.ts holds this
 * page in a frame, on the user's GPU): tell it what the server's headless browser sees of a
 * page itself — uncaught errors, console warnings and errors, failed requests.
 */
function reportToStudio() {
  const post = (event: Record<string, unknown>) => parent.postMessage({ frameRender: event }, location.origin);
  const text = (value: unknown) => (value instanceof Error ? value.message : typeof value === "string" ? value : String(value));
  addEventListener("error", (event) => post({ kind: "pageerror", message: event.message, stack: event.error?.stack }));
  addEventListener("unhandledrejection", (event) => post({ kind: "pageerror", message: text(event.reason), stack: event.reason?.stack }));
  for (const [method, level] of [
    ["error", "error"],
    ["warn", "warning"],
  ] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      post({ kind: "console", level, text: args.map(text).join(" ").slice(0, 2000) });
      original(...args);
    };
  }
  // Failed requests. Fetches tell when their answer comes (resource timing waits until the body
  // is read, which may be never); a fetch marked X-Frame-Optional probes for a file that may
  // legitimately be missing. Other loads (images, media, fonts, modules) by resource timing.
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    // Not `new Request(input, init)`: it would take a streamed body away from the fetch.
    const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
    const optional = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has("X-Frame-Optional");
    return fetch(input, init).then((response) => {
      if (response.status >= 400 && !optional) post({ kind: "response", status: response.status, url });
      return response;
    });
  };
  const failed = (entries: PerformanceEntryList) => {
    for (const entry of entries as (PerformanceResourceTiming & { responseStatus?: number })[])
      if ((entry.responseStatus ?? 0) >= 400 && entry.initiatorType !== "fetch") post({ kind: "response", status: entry.responseStatus, url: entry.name });
  };
  const observer = new PerformanceObserver((list) => failed(list.getEntries()));
  observer.observe({ type: "resource", buffered: true });
  // Before the studio page answers a call: what finished loading so far, not only after the observer's delay.
  (window as unknown as { __FRAME_RENDER_FLUSH__: () => void }).__FRAME_RENDER_FLUSH__ = () => failed(observer.takeRecords());
}
