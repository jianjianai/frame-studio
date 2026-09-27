import type { AnimationProject } from "../../engine/types";
const project: AnimationProject = {
  ...{
    id: "sunny-rail",
    title: "日光快线",
    subtitle: "把一座小岛，装进一段旅程。",
    description:
      "一辆橙色列车穿行在微缩岛屿上，经过车站、树林和风车。检验真实三维场景、轮轴动作、灯光阴影以及连续摄影机轨迹。",
    renderer: "three",
    duration: 36,
    fps: 30,
    accent: "#b9cfa4",
    poster: "posters/sunny-rail.webp",
    audio: "audio/sunny-rail.wav",
    tags: ["3D 微缩场景", "轨道摄影机", "光照与阴影"],
    status: "demo",
    beats: [
      {
        at: 0,
        title: "发车",
        detail: "完整岛屿建立空间关系，列车从车站起步。",
      },
      {
        at: 8,
        title: "进入山林",
        detail: "镜头靠近运动主体，车轮与车厢同步前进。",
      },
      {
        at: 18,
        title: "绕过风车",
        detail: "镜头连续绕岛，远近物体形成视差。",
      },
      {
        at: 28,
        title: "回到站台",
        detail: "镜头拉回全景，列车减速归站。",
      },
    ],
    subtitles: [
      {
        start: 1,
        end: 6,
        text: "小小的车站，装得下很大的出发。",
      },
      {
        start: 10,
        end: 16,
        text: "穿过山林，时间有了风的形状。",
      },
      {
        start: 20,
        end: 26,
        text: "每一次转弯，都能遇见新的风景。",
      },
      {
        start: 30,
        end: 36,
        text: "旅程回到原点，眼中的世界却已不同。",
      },
    ],
    credits: [
      "微缩场景、列车模型与动作：本项目原创",
      "演示配乐：原创节奏与旋律的离线合成音轨",
      "Three.js；支持扩展 glTF / GLB 模型与骨骼动画",
    ],
  },
  load: () => import("./scene"),
};
export default project;
