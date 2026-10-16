import { projectSchema, sampleSchema, type AnimationProject, type ProjectMeta, type SceneModule } from "../engine/types";
import { audioWindow, validateAudioDocument } from "../engine/audio-document.mjs";
import { resolveProject } from "../engine/resolve-project";
import { setTempo } from "../engine/tempo";
import { materialBaseOf, setMaterialBase } from "../engine/materials";

export interface WorkSource {
  /** /@fs URL of the work's project.ts */
  module: string;
  /** URL prefix that maps films/<slug>/... to the work's public/ folder */
  assetBase: string;
  /**
   * /@fs URL of another module of the work that exports createScene (a character sheet, one
   * part on its own): drawn instead of the film, without its timeline, audio or subtitles.
   */
  scene?: string;
}

export function workSourceFromQuery(params = new URLSearchParams(location.search)): WorkSource {
  const module = params.get("module");
  const assetBase = params.get("assetBase");
  if (!module || !assetBase) throw new Error("预览地址缺少 module/assetBase 参数");
  return { module, assetBase, scene: params.get("scene") || undefined };
}

/**
 * Import (or re-import after an edit) a work. `timestamp` busts the browser
 * module cache; Vite has already given changed modules the same timestamp.
 * `materialStamp` is the timestamp of the last change to the library code copies.
 */
export async function importWork(source: WorkSource, timestamp?: number, materialStamp?: number): Promise<AnimationProject> {
  (globalThis as { __FRAME_ASSET_BASE__?: string }).__FRAME_ASSET_BASE__ = source.assetBase;
  setMaterialBase(materialBaseOf(source.module), materialStamp);
  const url = source.module + (timestamp ? `?t=${timestamp}` : "");
  const mod = (await import(/* @vite-ignore */ url)) as { default: AnimationProject };
  const project = mod.default;
  if (!project || typeof project !== "object") throw new Error("project.ts 没有默认导出作品对象");
  const parsed = projectSchema.safeParse(project);
  if (!parsed.success)
    throw new Error("project.ts 元数据无效：" + parsed.error.issues.map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`).join("；"));
  const meta = parsed.data;
  setTempo(meta.tempo);
  if (source.scene) return importScene(source.scene, project, meta, timestamp);
  return resolveProject({
    ...meta,
    load: project.load,
    loadAudio: project.loadAudio,
    loadVisual: project.loadVisual,
    loadAudioDocument: project.loadAudioDocument,
  });
}

/**
 * A module drawn on its own: as long as its `sample` says (else the work), silent, or with the
 * work's sound from `sample.audioFrom` on; then the beat grid and subtitles move along with it.
 */
async function importScene(scene: string, project: AnimationProject, meta: ProjectMeta, timestamp?: number): Promise<AnimationProject> {
  const name = decodeURI(scene).replace(/^.*\/projects\/[^/]+\//, "");
  const mod = (await import(/* @vite-ignore */ scene + (timestamp ? `?t=${timestamp}` : ""))) as Partial<SceneModule> & { sample?: unknown };
  if (typeof mod.createScene !== "function") throw new Error(`${name} 没有导出 createScene(options)`);
  const parsed = sampleSchema.safeParse(mod.sample ?? {});
  if (!parsed.success)
    throw new Error(
      `${name} 的 sample 无效（写 export const sample = { duration: 秒数, audioFrom: 作品里的秒数 }）：` +
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`).join("；"),
    );
  const sample = parsed.data;
  const duration = sample.duration ?? meta.duration;
  const from = sample.audioFrom;
  const base = { ...meta, duration, beats: [], subtitles: [], sample, load: async () => mod as SceneModule };
  if (from === undefined) return base;
  const tempo = meta.tempo && { ...meta.tempo, firstBeat: meta.tempo.firstBeat - from };
  setTempo(tempo);
  const audio = project.loadAudioDocument
    ? validateAudioDocument((await project.loadAudioDocument()).default, { projectId: meta.id, duration: meta.duration })
    : undefined;
  return {
    ...base,
    tempo,
    subtitles: meta.subtitles
      .filter((line) => line.end > from && line.start < from + duration)
      .map((line) => ({ ...line, start: Math.max(0, line.start - from), end: Math.min(duration, line.end - from) })),
    ...(audio ? { audioDocument: audioWindow(audio, from, duration), loadAudio: project.loadAudio } : {}),
  };
}

/** Classify changed files so the player only rebuilds what changed. */
export function changeKinds(files: string[]) {
  let visual = false,
    audio = false;
  for (const file of files) {
    // Library code may be a sound module named by audio.json as well as drawing code.
    if (/project\.ts$/.test(file) || file.includes("/.materials/")) visual = audio = true;
    else if (/(^|\/)(audio[^/]*|music|sound[^/]*)(\/|\.|$)/i.test(file) || /\.(wav|mp3|ogg|opus|flac|m4a|aac|sf2|mid)$/i.test(file)) audio = true;
    else visual = true;
  }
  return { visual, audio };
}
