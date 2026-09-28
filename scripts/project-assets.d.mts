import type { Plugin } from "vite";
export function projectAssets(options?: { project?: string }): Plugin;
export function assetCatalog(
  root: string,
  ids?: string[],
): { url: string; type: string; bytes: number; license: string }[];
