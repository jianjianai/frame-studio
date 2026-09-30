import type { parse } from "@babel/parser";
export interface StaticProjectMeta {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  renderer: import("../src/engine/adapters.mjs").RendererId;
  visual?: import("../src/engine/compositor").VisualDocument;
  status: "draft" | "demo" | "film";
  duration: number;
  fps: number;
  poster: string;
  audio?: string;
  audioDocument?: import("../src/engine/types").AudioDocument;
  audioTracks?: import("../src/engine/types").AudioTrack[];
  research?: string;
  tags: string[];
  credits: string[];
  beats: { at: number; title: string; detail: string }[];
  subtitles: { start: number; end: number; text: string }[];
}
export interface StaticProject {
  file: string;
  directory: string;
  meta: StaticProjectMeta;
  loadPath?: string;
  audioLoadPath?: string;
  audioDocumentLoadPath?: string;
  visualLoadPath?: string;
}
export function validProjectId(id: unknown): boolean;
export function sourceFile(file: string): ReturnType<typeof parse>;
export function visitNodes(node: unknown, visit: (node: any) => void): void;
export function expressionName(node: any): string;
export function readProject(file: string): StaticProject;
export function readProjectCatalog(root?: string): StaticProject[];
