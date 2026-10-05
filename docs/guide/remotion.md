# remotion：用 React 组件做视频

适合排版、字体、CSS 动画、SVG 图表等。Remotion 组件是整部作品的根，`project.ts` 写：

```ts
renderer: "remotion",
load: () => import("./scene"),
loadRemotion: () => import("./composition"),
```

```ts
// scene.ts
import type { SceneOptions } from "../../src/engine/types";
import { createRemotionScene } from "../../src/engine/remotion-adapter";
import project from "./project";
export const createScene = (options: SceneOptions) => createRemotionScene(options, project);
```

```tsx
// composition.tsx
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig, Img } from "remotion";
import { FrameScene } from "../../src/engine/remotion-composition";
import { assetUrl } from "../../src/engine/types";

export default function Film() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 16 } });
  return (
    <AbsoluteFill style={{ background: "#0f172a", color: "white", fontFamily: "system-ui" }}>
      <Sequence from={0} durationInFrames={fps * 3}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontSize: 120, transform: `scale(${enter})` }}>
          你好
        </AbsoluteFill>
      </Sequence>
      <Sequence from={fps * 3}>
        {/* 嵌入任意 FRAME Canvas / Pixi / Three 场景 */}
        <FrameScene load={() => import("./scenes/particles")} />
      </Sequence>
      <Img src={assetUrl("films/work-1a2b3c4d/logo.png")} style={{ position: "absolute", right: 40, top: 40, width: 160, opacity: interpolate(frame, [0, 20], [0, 1]) }} />
    </AbsoluteFill>
  );
}
```

- 时间用 `useCurrentFrame()`，帧率、尺寸来自 project.ts。不要用 `setTimeout`、CSS transition 或 `@keyframes` 驱动动画。
- 图片用 `assetUrl(...)`，不要用 `staticFile`。
- 可用 `@remotion/transitions`（TransitionSeries）做转场。
- Remotion 根不能放进 visual.json 的图层；反过来可以用 `FrameScene` 嵌入其他场景。
- 声音建议放在 `audio.json`（见 `audio`）：在时间轴上可见、可混音，预览与导出一致。
