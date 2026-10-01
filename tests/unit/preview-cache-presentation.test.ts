import { expect, it } from "vitest";
import {
  previewCachePresentation,
  type PreviewCacheState,
} from "../../src/engine/live-preview-cache";
const complete: PreviewCacheState = {
  state: "error",
  totalFiles: 60,
  completeFiles: 60,
  totalBytes: 39271050,
  downloadedBytes: 39271050,
  persistentFiles: 60,
  remaining: [],
  error: "scene failed",
};
it("separates complete cached bytes from failed/cancelled playback preparation", () => {
  expect(previewCachePresentation(complete)).toEqual({
    resourcesComplete: true,
    title: "素材已缓存，播放器准备失败",
    retryLabel: "重试准备播放",
  });
  expect(
    previewCachePresentation({ ...complete, state: "cancelled" }).title,
  ).toBe("素材已缓存，播放准备已取消");
  expect(previewCachePresentation({ ...complete, state: "ready" }).title).toBe(
    "缓存与画面已就绪",
  );
  expect(
    previewCachePresentation({
      ...complete,
      completeFiles: 59,
      remaining: [
        { path: "image.png", bytes: 10, downloadedBytes: 0, state: "error" },
      ],
    }),
  ).toEqual({
    resourcesComplete: false,
    title: "缓存未完成",
    retryLabel: "继续缓存",
  });
  expect(
    previewCachePresentation({
      ...complete,
      totalFiles: 0,
      completeFiles: 0,
      totalBytes: 0,
      downloadedBytes: 0,
    }).resourcesComplete,
  ).toBe(false);
});
