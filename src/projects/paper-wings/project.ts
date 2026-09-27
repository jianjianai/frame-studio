import type { AnimationProject } from "../../engine/types";
const project: AnimationProject = {
  ...{
    id: "paper-wings",
    title: "风的邮差",
    subtitle: "一封信，越过山海。",
    description:
      "纸飞机离开山间小镇，穿过树林与海湾，在灯塔下折回信封、落入信箱。钢琴与木管展开旅程，海风、投递与亮灯共同完成结尾。",
    renderer: "pixi",
    duration: 32,
    fps: 30,
    accent: "#edaa7e",
    poster: "posters/paper-wings.webp",
    audio: "audio/paper-wings.wav",
    tags: ["2D 分层插画", "视差镜头", "路径运动"],
    status: "demo",
    beats: [
      {
        at: 0,
        title: "小镇起飞",
        detail: "纸飞机从屋檐飞出，镜头从环境全景开始跟随。",
      },
      {
        at: 7,
        title: "穿越群山",
        detail: "远山、中景与近景使用不同视差速度。",
      },
      {
        at: 17,
        title: "掠过海湾",
        detail: "近景树木遮挡，连贯移动至海岸。",
      },
      {
        at: 26,
        title: "抵达灯塔",
        detail: "纸飞机减速，灯塔亮起，镜头拉远。",
      },
    ],
    subtitles: [
      {
        start: 1,
        end: 6,
        text: "风把一封小小的信，带出了山间小镇。",
      },
      {
        start: 9,
        end: 14,
        text: "越过群山，也越过看不见的距离。",
      },
      {
        start: 18,
        end: 24,
        text: "海的另一边，有一盏灯正在等它。",
      },
      {
        start: 27,
        end: 32,
        text: "抵达的，不只是消息。还有远方的惦念。",
      },
    ],
    credits: [
      "插画与动作：本项目原创",
      "原创室内乐配乐：钢琴、竖琴、长笛、弦乐与大提琴；GeneralUser GS 乐器采样",
      "PixiJS + 连续摄影机；风、海浪与投递动作音效同轴混音",
    ],
  },
  load: () => import("./scene"),
};
export default project;
