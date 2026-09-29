import { useEffect, useRef, useState } from "react";
import { request } from "./ui";
export {
  decodePlayerMessage,
  positionReference,
} from "../src/contracts/player-bridge.mjs";

/** One owner for the immutable build, capability renewal and reference identity currently on screen. */
export function usePreviewSession({ workId, latest, blocked, notify }) {
  const [preview, setPreview] = useState(null);
  const [stage, setStage] = useState("正在获取作品…");
  const [error, setError] = useState("");
  const [retryGeneration, retryRequest] = useState(0);
  const [playerGeneration, restartPlayer] = useState(0);
  const requestedRetry = useRef(0);
  const generation = useRef(0);
  const current = useRef(null);
  current.current = preview;
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setStage("正在获取作品…");
    setError("");
  }, [workId]);
  useEffect(() => {
    const forced = requestedRetry.current !== retryGeneration;
    if (!latest || blocked || (!forced && current.current?.id === latest.id))
      return;
    requestedRetry.current = retryGeneration;
    const version = ++generation.current;
    const started = performance.now();
    let cancelled = false;
    request(`/api/tasks/${latest.id}/preview`, { method: "POST" })
      .then((link) => {
        if (cancelled || generation.current !== version) return;
        setPreview({
          ...link,
          id: latest.id,
          sourceCommit: latest.source_commit || null,
          fingerprint: latest.fingerprint || null,
          previewVersion: latest.result?.previewVersion || 0,
          requestedAt: started,
        });
        if (
          current.current?.id !== latest.id ||
          current.current?.url !== link.url
        )
          setStage("正在下载播放器…");
        setError("");
      })
      .catch((error) => {
        if (!cancelled && generation.current === version) {
          setError(error.message);
          notify(error.message, "error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workId, latest?.id, blocked, retryGeneration]);
  useEffect(() => {
    if (!preview || blocked) return;
    const id = preview.id;
    let cancelled = false;
    const refresh = () =>
      request(`/api/tasks/${id}/preview`, { method: "POST" })
        .then((link) => {
          if (!cancelled)
            setPreview((previous) =>
              previous?.id === id ? { ...previous, ...link } : previous,
            );
        })
        .catch((error) => {
          if (!cancelled) setError(error.message);
        });
    const timer = setInterval(refresh, 20 * 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [preview?.id, blocked]);
  const reference = preview?.sourceCommit
    ? { previewTask: preview.id, sourceCommit: preview.sourceCommit }
    : {};
  return {
    preview,
    stage,
    setStage,
    error,
    reference,
    playerGeneration,
    retry() {
      setError("");
      retryRequest((value) => value + 1);
    },
    restart() {
      setStage("正在重新准备播放器…");
      restartPlayer((value) => value + 1);
    },
  };
}
