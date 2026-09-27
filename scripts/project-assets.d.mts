import type { Plugin } from "vite";
export function projectAssets(): Plugin;
export function assetCatalog(
  root: string,
): { url: string; type: string; bytes: number; license: string }[];
