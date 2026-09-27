# 制作一部新动画

## 1. 明确片子的动作，而不是先写说明文字

写出：主角是什么、目标是什么、经过怎样的变化、镜头如何跟随、结尾如何由前面的动作自然发生。把配音和字幕当成补充，而不是画面无法讲清楚时的替代物。

技术选择：分层插画与精灵使用 PixiJS；真正三维空间和骨骼使用 Three.js；路径形变、解释性矢量角色使用 Canvas + Flubber。已经有的 renderer 协议足以混用不同项目，通常无需换掉整个播放器。

## 2. 新建并自动注册

```powershell
pnpm animation:new my-film "我的动画" --renderer three
```

生成 src/projects/my-film/project.ts 与 scene.ts。刷新工作台即可看到，开发时热更新；生产静态站点新增作品后需要重新 pnpm build。

project.ts 保存片长（秒）、帧率、简介、封面、音乐路径、镜头时间标记、字幕与署名。元数据会用 Zod 校验。id 仅使用小写英文开头的字母/数字/连字符；不要改为含路径的标识符。status 为 draft、demo、film，不能把未完成模板标成 film。

beats 是可点击的镜头导航，不是剪辑列表；其分段不会切换成 PPT。真正的连续叙事在 scene.render(time) 中完成。

## 3. 场景生命周期

```typescript
import type { Scene, SceneOptions } from "../../engine/types";

export async function createScene(options: SceneOptions): Promise<Scene> {
  const { width, height } = options;
  // 创建一次 Canvas / WebGL / 角色 / 素材 / timeline。
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  return {
    canvas,
    render(time) {
      // 每帧从 time 计算完整状态，不能依赖上一帧。
      context.fillStyle = "#e4ead9";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#617c63";
      context.beginPath();
      context.arc(
        width * 0.5 + Math.sin(time) * 80,
        height * 0.5,
        30,
        0,
        Math.PI * 2,
      );
      context.fill();
    },
    dispose() {
      // 清理自己创建的资源，不误删其他项目共享纹理。
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
```

示例中的圆是工程起步模板，不是正式交付画面。后续应替换成真正角色、分层插画或模型。

FrameRenderer 将任意 Scene 的画布复制到统一输出 Canvas，再绘制字幕，因此 PNG、WebM 和 MP4 共用同一画面。不要直接依赖 DOM 文案来讲述片中内容；导出只捕获 Canvas。

## 4. GSAP、随机数和动作

```typescript
const motion = { x: 0, y: 0, cameraZoom: 1 };
const timeline = gsap.timeline({ paused: true });
timeline.to(motion, { x: 500, duration: 4, ease: "sine.inOut" }, 0);
timeline.to(motion, { y: 180, duration: 3, ease: "power2.inOut" }, 3);
// 在 render(time) 中：
timeline.seek(time, true);
// 然后将 motion 用到角色和镜头，最后绘制。
// dispose：timeline.kill()。
```

每次渲染相同 time 应有相同像素。初始化时用 engine/math.ts 的 seeded(seed) 生成树木、星星、灰尘分布；粒子的当前坐标由出生时间和绝对 time 推导。不能依赖 Math.random() 或用 position.x += speed 逐帧累加。

没有自己的 requestAnimationFrame，也不要启动 Pixi ticker、Three setAnimationLoop 或 GSAP 自主播放。共用播放器已经管理帧调度和声音时钟。

## 5. 图片、模型与素材

```powershell
pnpm assets:import "D:/assets/character.png" --license "作者名，许可范围，来源"
pnpm assets:import "D:/assets/character.glb" --license "自制模型"
```

图片转为 WebP 或压缩 SVG；原文件不修改。未提供授权时索引会明确标为未确认。导入 GIF、视频和音频按原容器复制，不承诺重编码。带外部资源的 glTF 会拒绝导入，先导出自包含 GLB，避免看似成功但缺贴图。

```typescript
import { assetUrl } from "../../engine/types";
import {
  loadGltf,
  disposeObject,
  setAnimationTime,
} from "../../engine/three-assets";

// Pixi：await Assets.load(assetUrl('imports/character.webp'))。
// Three：
const model = await loadGltf("imports/character.glb", renderer);
scene.add(model.scene);
const mixer = new THREE.AnimationMixer(model.scene);
if (model.animations[0]) mixer.clipAction(model.animations[0]).play();
// render(time)：setAnimationTime(mixer, time)。
// dispose：mixer.stopAllAction(); mixer.uncacheRoot(model.scene);
// disposeObject(model.scene) 释放模型几何、材质、纹理。
```

模型压缩解码器来自 Three.js 自带的 Draco / Basis 文件，保存到 public/vendor/。原始纹理与 HDR 环境也应本地化，并记录授权。需要高级后处理时可使用 createPostPipeline；不是每部片子都应该开启 Bloom。

## 6. 声音与字幕

project.audio 是 public/ 下的完整音轨路径。音乐、旁白、环境音、撞击声先在音频工具或 FFmpeg 中合成一条对应片长的立体声音轨，不再分别依赖浏览器计时器。可用脚本 pnpm audio:mix 合并本地音频，说明见 docs/AUDIO.md。

正常播放，AudioContext.currentTime 同时决定音轨采样位置和画面时间；拖动时音源在新偏移处重启；倍速同时影响源的播放速度与画面。当前采用直接变速，因此音高会随倍速改变，不是保音高的时间伸缩。暂停停止声音，后台自动暂停。

字幕格式：

```typescript
subtitles: [{ start: 1.2, end: 4.8, text: "一段简洁的中文字幕。" }];
```

开始包含、结束不包含；不能超过片长。字幕使用系统中文字体绘制到输出 Canvas，导出 SRT 保留毫秒。暂无字词逐个高亮、内置 TTS、自动对齐或 ASR；需要这些能力时单独接入并验证。

## 7. 输出与验收

先看低分辨率短片段：

```powershell
pnpm render my-film --start 5 --end 10 --width 640 --fps 24
```

确定美术/动作/音乐后，再输出 1080p 或 4K 完整视频。离线输出会完整绘制每帧，慢机器只影响耗时，不改变时轴。

优先检查中间帧而不是只有头尾：跳至 10 秒，跳至 23 秒，再回到 10 秒；画面应该一致。截取一小段 MP4 实际播放，核对音效时点、字幕、运动方向与清晰度。

单元测试关注 Clock、schema、字幕、完整音轨与脚手架安全。E2E 关注作品库、真实画面、反向拖动、暂停冻结、循环、音量/音频状态、逐帧、导出、移动布局。新增场景应加入针对性的浏览器和图像比较，而不是只复用模板就宣称完成。

## 8. 调试

正常开发页提供 window.**FRAME_STUDIO** 调试入口。生产播放器只有带 ?debug=1 时开放。无 UI 的逐帧渲染页始终提供此接口：

```text
/?render=tiny-seed&width=1280&time=25&subtitles=1
```

await ready 后调用 frame(seconds, subtitles)、dataURL()。这个入口供自动化和导出使用，不处理音频播放，MP4 音频由 FFmpeg 离线复用完整音轨。

## 9. 不把基础设施当成质量保证

持续积累场景组件和真实可复用素材，避免每部片子重新画占位图。照片、分层图、二维角色骨骼、glTF 模型、摄影机预演和专业音乐可以在同一个项目里共存。对于生产级影视资产，外部建模/绘画/剪辑工具仍可能必要；浏览器引擎不会自动完成这些创作。
