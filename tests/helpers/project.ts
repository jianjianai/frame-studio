import type { AnimationProject } from "../../src/engine/types";
const project: AnimationProject = {
  id: "test-film",
  title: "Fixture",
  subtitle: "",
  description: "",
  renderer: "canvas",
  duration: 30,
  fps: 30,
  accent: "#718c51",
  poster: "films/test-film/poster.svg",
  tags: [],
  status: "draft",
  beats: [],
  subtitles: [],
  credits: [],
  load: async () => {
    throw Error("Metadata fixture only");
  },
};
export default project;
