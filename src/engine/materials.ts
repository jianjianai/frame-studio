/**
 * Library code named by documents (audio.json: `module: "materials/<library>/<file>.ts"`),
 * imported at run time from the work's .materials copies (the version the work uses; the
 * server copies a file there when it is first requested). The page that loads the work sets
 * the base; `stamp` changes when the copies change, so edited library code is imported anew.
 */
const holder = globalThis as { __FRAME_MATERIAL_BASE__?: string; __FRAME_MATERIAL_STAMP__?: number };

export const MATERIAL_MODULE = /^materials\/[^/]+\/[^?#]+\.(?:m?[jt]sx?)$/;

/** `/@fs/<work root>/projects/<slug>/project.ts` → `/@fs/<work root>/.materials/` */
export function materialBaseOf(projectModule: string) {
  const match = /^(.*\/)projects\/[^/]+\/project\.tsx?$/.exec(projectModule.split("?")[0]);
  if (!match) throw new Error("无法从作品地址得到素材库代码的位置：" + projectModule);
  return match[1] + ".materials/";
}

export function setMaterialBase(base: string, stamp?: number) {
  holder.__FRAME_MATERIAL_BASE__ = base;
  if (stamp !== undefined) holder.__FRAME_MATERIAL_STAMP__ = stamp;
}

export async function importMaterial<T = Record<string, unknown>>(ref: string): Promise<T> {
  if (!MATERIAL_MODULE.test(ref)) throw new Error(`不是素材库代码文件：${ref}（应为 materials/<素材库>/<路径>.ts）`);
  const base = holder.__FRAME_MATERIAL_BASE__;
  if (!base) throw new Error("没有设置素材库代码的位置（作品尚未加载）");
  const stamp = holder.__FRAME_MATERIAL_STAMP__;
  const url = base + ref.slice("materials/".length).split("/").map(encodeURIComponent).join("/") + (stamp ? `?t=${stamp}` : "");
  return (await import(/* @vite-ignore */ url)) as T;
}
