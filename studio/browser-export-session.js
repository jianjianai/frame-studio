import { useEffect, useRef, useState } from "react";
import { decodeExportMessage } from "../src/contracts/player-bridge.mjs";

const activeStates = ["queued", "running", "cancelling"];
const terminalStates = ["succeeded", "failed", "cancelled"];

/** Own the export independently of panel visibility. An unresponsive iframe is replaced, not silently left encoding. */
export function useBrowserExport(iframe, notify, onUnresponsive) {
  const [job, setJob] = useState(null);
  const current = useRef(null),
    file = useRef(null),
    callbacks = useRef({ notify, onUnresponsive });
  callbacks.current = { notify, onUnresponsive };
  current.current = job;
  const update = (value) => {
    current.current = value;
    setJob(value);
  };
  const releaseFile = () => {
    if (file.current) URL.revokeObjectURL(file.current.url);
    file.current = null;
  };
  const send = (command, extra = {}) =>
    iframe.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command, ...extra },
      "*",
    );
  const busy = activeStates.includes(job?.state);
  useEffect(() => {
    const receive = (event) => {
      if (event.source !== iframe.current?.contentWindow || !current.current)
        return;
      const value = decodeExportMessage(event.data, current.current.id);
      if (!value || terminalStates.includes(current.current.state)) return;
      // Progress already in transit must not turn "stopping" back into "running".
      if (
        current.current.state === "cancelling" &&
        !terminalStates.includes(value.state)
      )
        return;
      if (value.state === "queued" && current.current.state !== "queued")
        return;
      if (value.state === "succeeded") {
        if (
          !(value.blob instanceof Blob) ||
          value.blob.size <= 0 ||
          value.blob.size > 256 * 1024 * 1024
        ) {
          const error = "导出文件无效或超过本机缓存上限，播放器已重新初始化";
          update({ ...current.current, state: "failed", error });
          callbacks.current.notify(error, "error");
          callbacks.current.onUnresponsive?.();
          return;
        }
        releaseFile();
        file.current = {
          url: URL.createObjectURL(value.blob),
          bytes: value.blob.size,
          name: String(value.filename || "frame-export.webm")
            .replace(/[\\/\x00-\x1f]/g, "_")
            .slice(0, 180),
        };
      }
      update({
        ...current.current,
        state: value.state,
        progress: value.progress,
        error: value.error,
        filename: file.current?.name,
        bytes: file.current?.bytes,
        ...(value.sourceRevision
          ? { sourceRevision: value.sourceRevision }
          : {}),
        ...(value.compiledRevision
          ? { compiledRevision: value.compiledRevision }
          : {}),
      });
      if (value.state === "failed")
        callbacks.current.notify(value.error || "本机导出失败", "error");
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (activeStates.includes(current.current?.state)) send("export-cancel");
      releaseFile();
    };
  }, [iframe]);
  useEffect(() => {
    if (!busy) return;
    const protect = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy]);
  useEffect(() => {
    if (!["queued", "cancelling"].includes(job?.state)) return;
    const { id, state } = job;
    const timer = setTimeout(() => {
      if (current.current?.id !== id || current.current.state !== state) return;
      send("export-cancel");
      const error =
        state === "cancelling"
          ? "播放器未确认停止，已重新初始化播放器来终止本机导出"
          : "播放器未确认导出请求，已重新初始化，请重试";
      update({ ...current.current, state: "failed", error });
      callbacks.current.onUnresponsive?.();
      callbacks.current.notify(error, "error");
    }, 15000);
    return () => clearTimeout(timer);
  }, [job?.id, job?.state]);
  return {
    job,
    busy,
    start(options, reference = {}) {
      if (activeStates.includes(current.current?.state))
        throw Error("当前导出尚未完成");
      if (!iframe.current?.contentWindow) throw Error("请先等待播放器就绪");
      releaseFile();
      const next = {
        id: crypto.randomUUID(),
        state: "queued",
        ...(reference.sourceRevision
          ? { sourceRevision: reference.sourceRevision }
          : {}),
        ...(reference.compiledRevision
          ? { compiledRevision: reference.compiledRevision }
          : {}),
        ...(reference.sourceCommit
          ? { sourceCommit: reference.sourceCommit }
          : {}),
      };
      update(next);
      send("export-start", { id: next.id, options });
    },
    cancel() {
      if (!["queued", "running"].includes(current.current?.state)) return;
      update({ ...current.current, state: "cancelling" });
      send("export-cancel");
    },
    download() {
      if (!file.current) {
        notify("本机导出文件已不在当前标签页中，请重新导出", "error");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = file.current.url;
      anchor.download = file.current.name;
      anchor.click();
    },
  };
}
