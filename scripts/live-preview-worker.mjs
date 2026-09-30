import { fileURLToPath } from "node:url";

/** Hold one in-flight publication action and retain only the newest unsent bundle or error. */
export function createLivePreviewBundleSender({ send, onError }) {
  let sequence = 0, inFlight, pending, closed = false;
  const close = () => { closed = true; inFlight = undefined; pending = undefined; };
  const dispatch = action => {
    const id = ++sequence;
    inFlight = id;
    try {
      send({ ...action, id }, error => {
        if (error && !closed) { close(); onError?.(error); }
      });
    } catch (error) { close(); onError?.(error); }
  };
  const push = action => {
    if (closed) return;
    if (inFlight !== undefined) pending = action;
    else dispatch(action);
  };
  return {
    push: value => push({ type: "bundle", value }),
    pushError: value => push({ type: "error", value }),
    acknowledge(id) {
      if (closed || id !== inFlight) return;
      inFlight = undefined;
      const newest = pending; pending = undefined;
      if (newest !== undefined) dispatch(newest);
    },
    close,
  };
}

function runLivePreviewWorker() {
  let bundle, starting, shutdownPromise, closed = false;
  const shutdown = (code = 0) => {
    if (shutdownPromise) return shutdownPromise;
    closed = true; sender.close();
    shutdownPromise = (async () => {
      await starting;
      await bundle?.close();
      process.exit(code);
    })().catch(() => process.exit(1));
    return shutdownPromise;
  };
  const send = (message, callback) => {
    if (!process.connected || closed) return;
    try {
      process.send(message, error => {
        callback?.(error);
        if (error) void shutdown(1);
      });
    } catch (error) {
      callback?.(error); void shutdown(1);
    }
  };
  const sender = createLivePreviewBundleSender({ send, onError: () => void shutdown(1) });
  const report = error => sender.pushError({ message: String(error.message || error).slice(0, 4000) });
  process.on("message", message => {
    if (!message || closed) return;
    if (message.type === "start" && !starting) {
      starting = (async () => {
        try {
          const { createLivePreviewBundle } = await import("./live-preview-bundle.mjs");
          bundle = await createLivePreviewBundle({
            ...message.options,
            // Returning immediately keeps watch builds warm while the parent persists a revision.
            onBundle: value => sender.push(value),
            onState: value => send({ type: "state", value }),
            onError: report,
          });
        } catch (error) { report(error); }
      })();
    } else if (message.type === "publish-ack") sender.acknowledge(message.id);
    else if (message.type === "stop") void shutdown();
  });
  process.once("disconnect", () => void shutdown());
}

// Importing the sender in deterministic tests must not register process IPC handlers.
if (process.argv[1] === fileURLToPath(import.meta.url)) runLivePreviewWorker();
