import { api, workPath } from "../lib/api";
import { useAction } from "../lib/ui";
import type { Asset, ResourceItem } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { layerOf } from "./media";

/**
 * Putting things into the work at the playhead: a picture or video as a layer, a sound file or
 * a library sound on an audio track. Files of a library the work does not reference yet make
 * it referenced (the server links it while locking the file).
 */
export function usePlacement() {
  const { work, stage, reload } = useWorkbench();
  const [run, busy] = useAction();
  const base = workPath(work.repo, work.id);
  const addLayer = (asset: Asset) =>
    run(async () => {
      if (!work.meta?.visual) throw new Error("这个作品的画面完全由代码绘制，没有图层文档。可以把素材引用给 AI，让它接入。");
      const start = stage.playback.get().time;
      const remaining = (work.meta?.duration ?? 10) - start;
      const layer = layerOf(asset);
      const length = Math.min(remaining, layer.length);
      const id =
        asset.path
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .replace(/^[^a-zA-Z]/, "m") +
        "_" +
        Math.random().toString(36).slice(2, 6);
      await api(`${base}/layers`, {
        body: {
          operations: [
            {
              op: "add",
              clip: {
                id,
                name: asset.path.split("/").pop(),
                source: layer.source,
                start,
                duration: Math.max(0.1, length),
                fit: "contain",
                ...(asset.kind === "video" ? { audio: { enabled: true } } : {}),
              },
            },
          ],
        },
      });
      await reload();
    }, "已添加到画面（时间轴最上层）");
  const placeAudio = (asset: Asset) =>
    run(async () => {
      await api(`${base}/audio/place`, {
        body: { src: asset.url, start: stage.playback.get().time, duration: asset.duration, track: "音效", name: asset.path.split("/").pop() },
      });
      await reload();
    }, "已放到「音效」音轨");
  const placeSound = (item: ResourceItem) =>
    run(async () => {
      await api(`${base}/audio/place`, { body: { sound: item.id, start: stage.playback.get().time, track: "音效", name: item.title } });
      await reload();
    }, `已把「${item.title}」放到「音效」音轨`);
  return { addLayer, placeAudio, placeSound, place: (asset: Asset, how: "layer" | "audio") => (how === "layer" ? addLayer(asset) : placeAudio(asset)), busy };
}
