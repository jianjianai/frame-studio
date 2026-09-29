import { projectSchema, type AnimationProject } from "../engine/types";
const modules = import.meta.glob<{ default: AnimationProject }>(
  "../../projects/*/project.ts",
  { eager: true },
);
import { resolveProject } from "../engine/resolve-project";
const seen = new Set<string>();
export const projects = (await Promise.all(Object.values(modules)
  .map(async ({ default: project }) => {
    const meta = projectSchema.parse(project);
    if (seen.has(meta.id)) throw new Error("重复的动画 id: " + meta.id);
    seen.add(meta.id);
    if (
      meta.audioTracks?.some((track) => track.kind === "generated") &&
      !project.loadAudio
    )
      throw new Error("代码音轨缺少 loadAudio: " + meta.id);
    return resolveProject({ ...meta, load: project.load, loadAudio: project.loadAudio, loadVisual:project.loadVisual });
  })))
  .sort((a, b) => a.id.localeCompare(b.id));
export const findProject = (id: string): AnimationProject | undefined =>
  projects.find((p) => p.id === id);
