import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { api, formatTime, workPath } from "../lib/api";
import { useToast } from "../lib/ui";
import { useWorkbench } from "./store";

const mimeType = () => ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";

/**
 * Record from the microphone onto the "录音" track. Recording starts at the
 * playhead and plays the work along, so narration lines up with the picture.
 */
export function RecordButton() {
  const { work, stage } = useWorkbench();
  const toast = useToast();
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const startAt = useRef(0);
  const timer = useRef(0);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((track) => track.stop()), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast("这个浏览器环境不能录音（需要 HTTPS 或 localhost）", "error");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      return toast("无法使用麦克风：" + (error as Error).message, "error");
    }
    const type = mimeType();
    const media = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 128000 } : undefined);
    const chunks: Blob[] = [];
    media.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    media.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      clearInterval(timer.current);
      stage.pause();
      setState("saving");
      try {
        const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
        const result = await api<{ duration: number }>(`${workPath(work.repo, work.id)}/recordings?start=${startAt.current.toFixed(3)}`, {
          raw: blob,
          contentType: blob.type.split(";")[0],
        });
        toast(`录音已放到「录音」音轨（${formatTime(startAt.current)} 开始，${result.duration?.toFixed(1) ?? "?"} 秒）`, "ok");
      } catch (error) {
        toast("保存录音失败：" + (error as Error).message, "error");
      } finally {
        setState("idle");
      }
    };
    startAt.current = stage.playback.get().time;
    media.start(250);
    recorder.current = media;
    setElapsed(0);
    const began = performance.now();
    timer.current = window.setInterval(() => setElapsed((performance.now() - began) / 1000), 200);
    setState("recording");
    void stage.play();
  };

  const stop = () => recorder.current?.state === "recording" && recorder.current.stop();

  if (state === "recording")
    return (
      <button className="record-btn recording" title="停止录音" onClick={stop}>
        <Square size={12} fill="currentColor" /> {formatTime(elapsed, false)}
      </button>
    );
  return (
    <button className="icon-btn" title="从当前位置录音（边播放边录）" disabled={state === "saving" || stage.status.get().status !== "ready"} onClick={start}>
      {state === "saving" ? <span className="spinner" /> : <Mic size={16} />}
    </button>
  );
}
