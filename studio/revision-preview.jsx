import { useEffect, useRef, useState } from "react";
import { decodePlayerMessage } from "../src/contracts/player-bridge.mjs";
import {
  api,
  request,
  useQuery,
  Button,
  ErrorNote,
  Loading,
  states,
} from "./ui";

/** A single immutable version player. Switching versions unmounts the previous player, so audio never doubles. */
export function RevisionPreview({
  work,
  version,
  previewTask,
  context = {},
  label = "版本播放器",
  onPosition,
}) {
  const [task, setTask] = useState(null),
    [url, setUrl] = useState(null),
    [error, setError] = useState(""),
    [revision, retry] = useState(0);
  const [ready, setReady] = useState(false);
  const frame = useRef(null),
    initialized = useRef(false),
    requestGeneration = useRef(0);
  const latestContext = useRef(context);
  latestContext.current = context;
  const query = useQuery(task?.id ? "task_get" : null, { id: task?.id }, 1);
  const row = query.data?.task || task;
  const callbacks = useRef(onPosition);
  callbacks.current = onPosition;
  useEffect(() => {
    let cancelled = false;
    const generation = ++requestGeneration.current;
    initialized.current = false;
    setReady(false);
    setError("");
    setUrl(null);
    setTask(null);
    const prepare = async () => {
      if (previewTask && revision === 0) {
        try {
          const link = await request(`/api/tasks/${previewTask}/preview`, {
            method: "POST",
          });
          if (!cancelled && generation === requestGeneration.current)
            setUrl(link.url);
          return;
        } catch {
          /* An expired/old runtime preview is rebuilt from the exact commit below. */
        }
      }
      if (!version)
        throw Error("旧结果没有可重建的源码版本，请使用版本管理查看现有预览");
      const value = await api("works_version_preview", {
        id: work.id,
        version,
      });
      if (!cancelled && generation === requestGeneration.current)
        setTask(value);
    };
    void prepare().catch((error) => {
      if (!cancelled) setError(error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [work.id, version, previewTask, revision]);
  useEffect(() => {
    if (!row || row.state !== "succeeded" || url) return;
    let cancelled = false;
    void request(`/api/tasks/${row.id}/preview`, { method: "POST" })
      .then((link) => {
        if (!cancelled) setUrl(link.url);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [row?.id, row?.state, url]);
  const send = (command, extra = {}) =>
    frame.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command, ...extra },
      "*",
    );
  useEffect(() => {
    const listener = (event) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = decodePlayerMessage(event.data);
      if (!message) return;
      if (message.type === "frame-player-ready")
        send("configure-view", {
          preferences: { timelineVisible: false, quality: "standard" },
        });
      if (
        message.type === "frame-preview-loading" &&
        message.message === "" &&
        !initialized.current
      ) {
        initialized.current = true;
        setReady(true);
        const value = latestContext.current;
        send("seek", {
          time: value.start ?? value.time ?? 0,
          ...(value.end > value.start
            ? { selection: { start: value.start, end: value.end } }
            : {}),
        });
      }
      if (message.type === "frame-player-state") callbacks.current?.(message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  const failed =
    error ||
    query.error ||
    (["failed", "cancelled", "publish_failed"].includes(row?.state)
      ? row.error || states[row.state]
      : "");
  return (
    <section className="revision-preview" aria-label={label}>
      {url && (
        <div className="result-version-switch">
          <Button
            disabled={!ready}
            onClick={() => {
              const value = latestContext.current;
              send("seek", {
                time: value.start ?? value.time ?? 0,
                ...(value.end > value.start
                  ? { selection: { start: value.start, end: value.end } }
                  : {}),
              });
              send("play", value.end > value.start ? { end: value.end } : {});
            }}
          >
            {context.end > context.start ? "播放所选片段" : "从引用位置播放"}
          </Button>
          <Button disabled={!ready} onClick={() => send("pause")}>
            暂停审片
          </Button>
        </div>
      )}
      {failed && (
        <>
          <ErrorNote error={failed} />
          <Button onClick={() => retry((value) => value + 1)}>
            重新准备此版本
          </Button>
        </>
      )}
      {!url && !failed && (
        <>
          <Loading />
          <p role="status">
            {row
              ? row.progress?.stage || states[row.state]
              : "正在获取本轮预览…"}
          </p>
        </>
      )}
      {url && (
        <iframe
          key={url}
          ref={frame}
          title={label}
          className="ai-result-player"
          src={url}
          sandbox="allow-scripts allow-downloads"
          allow="autoplay; fullscreen"
          allowFullScreen
        />
      )}
    </section>
  );
}
