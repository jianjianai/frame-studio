import type { AnimationProject } from "../../src/engine/types";
const project: AnimationProject = {
  ...{
    id: "tiny-seed",
    title: "一颗种子的四季",
    subtitle: "把看不见的生长，变成看得见的故事。",
    description:
      "一颗种子在雨中扎根、向阳开花，蜜蜂短暂停留，绒球成熟后把新种子交还给风。镜头从土壤近景跟随到花朵，以三拍子室内乐讲述生命循环的艺术寓言。",
    renderer: "canvas",
    duration: 36,
    fps: 30,
    accent: "#ebce84",
  poster: "films/tiny-seed/poster.webp",
  posterTime: 26.8,
    audio: "films/tiny-seed/audio/tiny-seed.wav",
    tags: ["矢量形变", "生长动画", "因果叙事"],
    status: "demo",
    beats: [
      {
        at: 0,
        title: "落入土壤",
        detail: "种子随风下落，镜头保留土壤横截面。",
      },
      {
        at: 6,
        title: "雨水与根系",
        detail: "降雨后根系逐渐向下延伸。",
      },
      {
        at: 14,
        title: "舒展与开花",
        detail: "茎叶生长，花瓣沿同一主时间轴展开。",
      },
      {
        at: 26,
        title: "授粉与新生",
        detail: "蜜蜂靠近花朵，新的种子继续随风启程。",
      },
    ],
    subtitles: [
      {
        start: 1,
        end: 5,
        text: "看起来微不足道的起点，藏着一整个春天。",
      },
      {
        start: 7,
        end: 12,
        text: "先向下扎根，才有向上生长的力量。",
      },
      {
        start: 16,
        end: 23,
        text: "叶子接住阳光，花朵回应世界。",
      },
      {
        start: 28,
        end: 36,
        text: "一段生命的绽放，也是下一段故事的开始。",
      },
    ],
    credits: [
      "矢量画面、花卉与角色动作：本项目原创",
      "原创三拍子配乐：钢琴、竖琴、大提琴、弦乐、长笛与钢片琴；GeneralUser GS 乐器采样",
      "Canvas 2D + GSAP + Flubber；雨滴、根系、花瓣、蜜蜂与种子启程的连续近景",
    ],
  },
  load: () => import("./scene"),
};
export default project;
