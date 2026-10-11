import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, Box, FileCode2, FileQuestion, FileText, Globe2, Sparkles, Type } from "lucide-react";
import { useServerEvent, type ServerEvent } from "../lib/api";
import type { Asset } from "../lib/types";

/** Media the studio draws itself (src/preview/asset.ts): models, Lottie, panoramas, fonts. */
export const DRAWN_KINDS = ["model", "lottie", "environment", "font"];
export const isDrawn = (kind: string) => DRAWN_KINDS.includes(kind);
/** Files that become a picture layer when put on the timeline. */
export const isVisual = (kind: string) => ["image", "video", "lottie", "model"].includes(kind);

export const KIND_NAMES: Record<string, string> = { image: "图片", video: "视频", audio: "音频", model: "三维模型", lottie: "Lottie 动画", environment: "全景图", font: "字体", code: "代码", data: "数据" };

/** The layer an asset becomes on the timeline (visual.json source), and how long it lasts by default. */
export function layerOf(asset: Asset): { source: Record<string, unknown>; length: number } {
  const src = asset.url;
  if (asset.kind === "lottie") return { source: { kind: "lottie", src }, length: asset.duration || 3 };
  if (asset.kind === "model") return { source: { kind: "model", src }, length: 5 };
  if (asset.kind === "video") return { source: { kind: "video", src }, length: asset.duration || 5 };
  return { source: { kind: "image", src }, length: 5 };
}

/** An icon for a kind of file without a picture of its own. */
export function KindIcon({ kind, size = 26 }: { kind: string; size?: number }) {
  if (kind === "audio") return <AudioLines size={size} />;
  if (kind === "model") return <Box size={size} />;
  if (kind === "lottie") return <Sparkles size={size} />;
  if (kind === "environment") return <Globe2 size={size} />;
  if (kind === "font") return <Type size={size} />;
  if (kind === "code") return <FileCode2 size={size} />;
  if (kind === "data") return <FileText size={size} />;
  return <FileQuestion size={size} />;
}

/** A Lottie animation's JSON (the fields the player needs), told from other JSON. */
export function isLottieText(text: string | undefined) {
  if (!text || !/"layers"\s*:/.test(text.slice(0, 200000))) return false;
  try {
    const data = JSON.parse(text);
    return Boolean(data && Array.isArray(data.layers) && ["fr", "ip", "op", "w", "h"].every((key) => typeof data[key] === "number"));
  } catch {
    return false;
  }
}

/**
 * A thumbnail the studio renders on the server: asked for when it comes into view (the
 * studio draws the latest requests first), shown when an event `done(event)` recognises
 * says it is there. Falls back to `icon` while waiting or when it cannot be drawn.
 */
export function ServerThumb({ src, done, icon, failedTitle, children }: { src: string; done: (event: ServerEvent) => boolean; icon: ReactNode; failedTitle?: string; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setImage("");
    setFailed(false);
  }, [src]);
  useEffect(() => {
    if (!visible || image || failed) return;
    let alive = true;
    let timer = 0;
    fetch(src).then(
      async (response) => {
        // Still in the queue: the event comes when it is drawn (asking again now and then in case it got lost).
        if (response.status === 202) timer = window.setTimeout(() => alive && setAttempt((n) => n + 1), 30000);
        else if (!response.ok) alive && setFailed(true);
        else {
          const url = URL.createObjectURL(await response.blob());
          if (alive) setImage(url);
          else URL.revokeObjectURL(url);
        }
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible, src, image, failed, attempt]);
  useEffect(() => () => void (image && URL.revokeObjectURL(image)), [image]);
  useServerEvent(
    (event) => {
      if (!done(event)) return;
      if (event.error) setFailed(true);
      else setAttempt((n) => n + 1);
    },
    [src],
  );
  return (
    <div ref={box} className="asset-thumb" title={failed ? failedTitle : undefined}>
      {image ? <img src={image} alt="" /> : icon}
      {children}
    </div>
  );
}
