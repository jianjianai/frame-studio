import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";

/** Only installed in the isolated build browser. Never changes authoring sources. */
export function installPreviewPreparation(project: AnimationProject) {
  let current = "",
    renderer: OfflineAudioRenderer | undefined;
  return {
    duration: project.duration,
    tracks: projectAudioTracks(project).map(({ id }) => id),
    async pcm(id: string, start: number, duration: number) {
      const track = projectAudioTracks(project).find((t) => t.id === id);
      if (!track) throw new Error("Unknown preview track");
      if (current !== id) {
        renderer?.dispose();
        current = id;
        renderer = new OfflineAudioRenderer(
          { ...project, audio: undefined, audioTracks: [track] },
          new Map([[id, { gain: 1, muted: false }]]),
          1,
        );
      }
      return renderer!.pcm(start, duration);
    },
    dispose() {
      renderer?.dispose();
    },
  };
}
