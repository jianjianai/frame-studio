import type { AnimationProject } from "../../engine/types";
const project: AnimationProject = {
  ...{
    id: "paper-wings",
    title: "风的邮差",
    subtitle: "一封信，越过山海。",
    description:
      "纸飞机从山间小镇起飞，掠过树林、桥梁与海湾，最终抵达灯塔。用分层插画、连续跟拍和前景遮挡检验二维叙事。",
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
      "演示配乐：项目内离线合成，可替换正式音乐",
      "PixiJS + GSAP；无外部运行时素材链接",
    ],
  },
  load: () => import("./scene"),
};
export default project;
