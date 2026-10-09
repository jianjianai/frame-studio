import { projectSchema, type AnimationProject } from "../engine/types";
import { resolveProject } from "../engine/resolve-project";
import { setTempo } from "../engine/tempo";
import { materialBaseOf, setMaterialBase } from "../engine/materials";

export interface WorkSource {
  /** /@fs URL of the work's project.ts */
  module: string;
  /** URL prefix that maps films/<slug>/... to the work's public/ folder */
  assetBase: string;
}

export function workSourceFromQuery(params = new URLSearchParams(location.search)): WorkSource {
  const module = params.get("module");
  const assetBase = params.get("assetBase");
  if (!module || !assetBase) throw new Error("预览地址缺少 module/assetBase 参数");
  return { module, assetBase };
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
  return resolveProject({
    ...meta,
    load: project.load,
    loadAudio: project.loadAudio,
    loadVisual: project.loadVisual,
    loadAudioDocument: project.loadAudioDocument,
  });
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
