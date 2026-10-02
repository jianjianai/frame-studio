import { useEffect, useRef, useState } from "react";
import { validPreviewMode } from "../src/engine/live-preview-cache";

/** One subscription per iframe attachment; UI state never changes its URL. */
export function usePreviewMediaSession({
  iframe,
  playerElement,
  playerKey,
  live,
  onMode,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const bridge = useRef(null);
  const modeCallback = useRef(onMode);
  modeCallback.current = onMode;
  useEffect(() => {
    setSnapshot(null);
    if (!live || !playerElement) return;
    let channel = crypto.randomUUID();
    let request = null,
      remoteState = null,
      timer,
      disposed = false;
    const current = () => !disposed && iframe.current === playerElement;
    const send = (message) => {
      if (current())
        playerElement.contentWindow?.postMessage({ ...message, channel }, "*");
    };
    const subscribe = () => send({ type: "frame-preview-media-subscribe" });
    const loaded = () => {
      channel = crypto.randomUUID();
      clearTimeout(timer);
      request = null;
      remoteState = null;
      setSnapshot(null);
      subscribe();
    };
    const receive = (event) => {
      if (!current() || event.source !== playerElement.contentWindow) return;
      const data = event.data;
      // React may install the shell bridge after the iframe load event.
      if (data?.type === "frame-preview-media-ready") {
        subscribe();
        return;
      }
      if (data?.channel !== channel) return;
      if (
        data.type === "frame-preview-media-state" &&
        validPreviewMode(data.state?.mode)
      ) {
        remoteState = data.state;
        modeCallback.current(data.state.mode);
        setSnapshot({
          ...data.state,
          pendingAction: request?.action || data.state.pendingAction,
          attachment: playerKey,
        });
      } else if (
        data.type === "frame-preview-media-result" &&
        request?.id === data.requestId
      ) {
        clearTimeout(timer);
        request = null;
        setSnapshot(
          (previous) =>
            previous && {
              ...previous,
              pendingAction: remoteState?.pendingAction || "",
              controlError: data.error || "",
            },
        );
      }
    };
    const command = (action, mode) => {
      if (!current() || request) return;
      request = { id: crypto.randomUUID(), action };
      setSnapshot(
        (previous) =>
          previous && { ...previous, pendingAction: action, controlError: "" },
      );
      send({
        type: "frame-preview-media-command",
        requestId: request.id,
        action,
        ...(mode ? { mode } : {}),
      });
      timer = setTimeout(() => {
        request = null;
        setSnapshot(
          (previous) =>
            previous && {
              ...previous,
              pendingAction: remoteState?.pendingAction || "",
              controlError: "预览未及时响应，请等待当前操作完成后重试。",
            },
        );
      }, 30000);
    };
    bridge.current = command;
    window.addEventListener("message", receive);
    playerElement.addEventListener("load", loaded);
    // Subscribe before Player exists as full-cache preparation can postpone its mount.
    subscribe();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      playerElement.removeEventListener("load", loaded);
      if (bridge.current === command) bridge.current = null;
    };
  }, [iframe, playerElement, playerKey, live]);
  return {
    state: snapshot?.attachment === playerKey ? snapshot : null,
    command: (action, mode) => bridge.current?.(action, mode),
  };
}
