import { z } from "zod";
export const subtitleSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().positive(),
    text: z.string().min(1),
  })
  .refine((s) => s.end > s.start, "字幕结束时间必须晚于开始时间");
export const projectSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    subtitle: z.string(),
    description: z.string(),
    renderer: z.enum(["pixi", "three", "canvas"]),
    duration: z.number().positive().max(3600),
    fps: z.number().int().min(12).max(60),
    accent: z.string(),
    poster: z.string(),
    audio: z.string().optional(),
    tags: z.array(z.string()),
    status: z.enum(["demo", "draft", "film"]).default("demo"),
    beats: z.array(
      z.object({
        at: z.number().nonnegative(),
        title: z.string(),
        detail: z.string(),
      }),
    ),
    subtitles: z.array(subtitleSchema),
    credits: z.array(z.string()),
  })
  .superRefine((p, ctx) => {
    for (const s of p.subtitles)
      if (s.end > p.duration)
        ctx.addIssue({ code: "custom", message: "字幕不能超过片长" });
    for (const b of p.beats)
      if (b.at >= p.duration)
        ctx.addIssue({ code: "custom", message: "镜头标记不能超过片长" });
  });
export type ProjectMeta = z.infer<typeof projectSchema>;
export type Quality = "draft" | "standard" | "high";
export interface SceneOptions {
  width: number;
  height: number;
  quality: Quality;
}
export interface Scene {
  canvas: HTMLCanvasElement;
  render(time: number): void;
  dispose(): void;
}
export interface SceneModule {
  createScene(options: SceneOptions): Promise<Scene> | Scene;
}
export interface AnimationProject extends ProjectMeta {
  load: () => Promise<SceneModule>;
}
export const assetUrl = (relative: string): string =>
  import.meta.env.BASE_URL + relative.replace(/^\//, "");
