import { validateAudioDocument } from "./audio-document.mjs";
import type { AnimationProject } from "./types";
import { validateVisualDocument } from "./visual-document.mjs";
/** Resolves only the project's declared document; never guesses or rewrites scene code. */
export async function resolveProject(
  project: AnimationProject,
): Promise<AnimationProject> {
  if(project.loadAudioDocument && !project.audioDocument){
    const audio = await project.loadAudioDocument();
    project={...project,audioDocument:validateAudioDocument(audio.default,{projectId:project.id,duration:project.duration})};
  }
  if (!project.loadVisual || project.visual) return project;
  const mod = await project.loadVisual();
  const visual = validateVisualDocument(mod.default, {
    projectId: project.id,
    duration: project.duration,
  });
  return { ...project, visual };
}
