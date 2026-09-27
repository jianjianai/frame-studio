import type { AnimationProject } from "../../src/engine/types";
const project: AnimationProject = {
  ...{
    id: "sunny-rail",
    title: "日光快线",
    subtitle: "把一座小岛，装进一段旅程。",
    description:
      "橙色列车伴着轻爵士驶过微缩岛屿。摄影机沿轨道外侧跟随，车轮、车厢、汽笛与轨缝节奏共同讲述一次从出发到归站的小旅行。",
    renderer: "three",
    duration: 36,
    fps: 30,
    accent: "#b9cfa4",
  poster: "films/sunny-rail/poster.webp",
  posterTime: 10.5,
    audioTracks: [
      { id: "music", name: "采样配乐", kind: "generated", gain: 1 },
      { id: "foley", name: "动作音效", kind: "generated", gain: 1 },
    ],
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
      "原创轻爵士配乐：钢琴、尼龙吉他、低音提琴、颤音琴、单簧管与刷鼓；GeneralUser GS 乐器采样",
      "Three.js；弧长车距、可见轮辐、外侧跟拍与真实距离驱动的轨缝音效",
    ],
  },
  load: () => import("./scene"),
  loadAudio: () => import("./audio"),
};
export default project;
