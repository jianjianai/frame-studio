import type { Plugin } from "vite";
export function projectAssets(): Plugin;
export function assetCatalog(
  root: string,
  ids?: string[],
): { url: string; type: string; bytes: number; license: string }[];
