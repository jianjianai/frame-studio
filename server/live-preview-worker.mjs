import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Bundling runs outside the HTTP event loop, with a bounded JS heap and bounded IPC diagnostics. */
export function createLivePreviewWorker({ onBundle, onError, onState, ...options }, { forkWorker = fork } = {}) {
  const child = forkWorker(fileURLToPath(new URL("../scripts/live-preview-worker.mjs", import.meta.url)), [], {
    cwd: options.root, execArgv: ["--max-old-space-size=768"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  let closing = false, unavailable = false, processing, pending, closePromise;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const fail = error => {
    if (unavailable) return;
    unavailable = true; pending = undefined;
    if (!closing) {
      const message = { type: "terminal-error", error };
      if (processing) pending = message;
      else publish(message);
    }
  };
  const send = message => {
    if (!child.connected) return;
    try {
      child.send(message, error => { if (error) fail(error); });
    } catch (error) { fail(error); }
  };
  const acknowledge = message => {
    if (!closing && !unavailable && message.id !== undefined) send({ type: "publish-ack", id: message.id });
  };
  const publish = message => {
    processing = Promise.resolve().then(() => {
      if (closing) return;
      if (message.type === "bundle") return onBundle(message.value);
      onError(message.error || Error(message.value?.message || "Live preview bundler failed"));
    }).catch(error => onError(error)).finally(() => {
      acknowledge(message);
      processing = undefined;
      const next = pending; pending = undefined;
      if (next && !closing) publish(next);
    });
  };
  child.on("message", message => {
    if (closing || unavailable || !message) return;
    if (message.type === "bundle" || message.type === "error") {
      // The ACK protocol allows one incoming bundle. Keep this side bounded too.
      if (processing) {
        if (pending) acknowledge(pending);
        pending = message;
      } else publish(message);
    } else if (message.type === "state") onState?.(message.value);
  });
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    resolveStopped();
    fail(Error("Live preview bundler stopped (" + (signal || code) + ")"));
  });
  child.once("close", resolveStopped);
  send({ type: "start", options });
  return {
    close() {
      if (closePromise) return closePromise;
      closing = true; pending = undefined;
      closePromise = (async () => {
        send({ type: "stop" });
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        timer.unref();
        try {
          if (child.exitCode === null && child.signalCode === null) await stopped;
          await processing;
        } finally { clearTimeout(timer); }
      })();
      return closePromise;
    },
  };
}
