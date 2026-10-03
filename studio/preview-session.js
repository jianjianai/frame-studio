import { useEffect, useRef, useState } from "react";
import { api, request } from "./ui";
import { createPreviewSessionController } from "./live-preview-session.mjs";
export {
  decodePlayerMessage,
  positionReference,
} from "../src/contracts/player-bridge.mjs";

/** One owner for preview attachment; live source revisions update within the persistent player. */
export function usePreviewSession({
  workId,
  latest,
  blocked,
  notify,
  mode = "immutable",
}) {
  const [state, setState] = useState({
    preview: null,
    stage: "正在获取作品…",
    error: "",
    status: "starting",
  });
  const [playerGeneration, restartPlayer] = useState(0);
  const controller = useRef(null),
    inputs = useRef(null);
  inputs.current = {
    workId,
    latest,
    blocked,
    mode,
  };
  useEffect(() => {
    const owner = createPreviewSessionController({
      loadLive: (args) => api("works_live_preview", args),
      loadStable: (task) =>
        request(`/api/tasks/${task.id}/preview`, { method: "POST" }),
      publish: setState,
    });
    controller.current = owner;
    owner.update(inputs.current);
    const reconnect = () => {
      const value = owner.getState();
      if (
        inputs.current.mode === "live" &&
        (value.status === "reconnecting" ||
          value.preview?.fallback ||
          Date.parse(value.preview?.expires || "") - Date.now() < 120000)
      )
        owner.retry();
    };
    const connected = (event) => {
      if (event.detail === "connected") reconnect();
    };
    const visible = () => {
      if (!document.hidden) reconnect();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    window.addEventListener("frame-connection", connected);
    return () => {
      owner.dispose();
      if (controller.current === owner) controller.current = null;
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("frame-connection", connected);
    };
  }, []);
  useEffect(() => {
    controller.current?.update(inputs.current);
  }, [workId, latest?.id, blocked, mode]);
  const { preview, stage, error, status } = state;
  const reference =
    preview?.live && /^[a-f0-9]{64}$/.test(preview.observedRevision || "")
      ? {
          liveSessionId: preview.sessionId,
          sourceRevision: preview.observedRevision,
          ...(preview.compiledRevision
            ? { compiledRevision: preview.compiledRevision }
            : {}),
        }
      : preview?.sourceCommit
        ? { previewTask: preview.id, sourceCommit: preview.sourceCommit }
        : {};
  return {
    preview,
    stage,
    error,
    status,
    reference,
    playerGeneration,
    setStage(value) {
      controller.current?.setStage(value);
    },
    receiveLive(message) {
      controller.current?.receive(message);
    },
    retry() {
      controller.current?.retry();
    },
    restart() {
      setState((previous) => ({ ...previous, stage: "正在重新准备播放器…" }));
      restartPlayer((value) => value + 1);
    },
  };
}
