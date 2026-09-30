import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chunkPath = z.string().regex(/^assets\/[A-Za-z0-9_.-]+\.js$/).max(1000);
const mediaPath = z.string().max(4096).refine(value => /^films\/[a-z][a-z0-9-]*\//.test(value) && !value.split("/").includes("..") && !/[?#\\]/.test(value));
export const livePreviewManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  sourceRevision: hash,
  source: z.enum(["work", "task"]),
  projectUrl: chunkPath,
  preloads: z.array(chunkPath).max(512).optional(),
  moduleGraph: z.record(chunkPath, z.object({
    imports: z.array(chunkPath).max(512), dynamicImports: z.array(chunkPath).max(512),
  })).refine(value => Object.keys(value).length <= 512).optional(),
  changes: z.object({ visual: z.boolean(), audio: z.boolean(), metadata: z.boolean() }),
  fingerprints: z.object({ visual: hash, audio: hash, metadata: hash }),
  createdAt: z.string().datetime(),
  buildMs: z.number().finite().nonnegative(),
  assetsRevision: hash,
  audioGeneratorRevision: hash.optional(),
  assetRevisions: z.record(mediaPath, hash).default({}),
  audioSources: z.record(mediaPath, z.object({
    revision: hash, url: z.string().max(4096).optional(), originalUrl: z.string().max(4096).optional(),
    renditions: z.record(z.string().max(200), z.string().max(4096)).optional(),
  })).default({}),
});
export const livePreviewStartingSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().min(1).max(200),
  revision: z.literal(0), state: z.literal("starting"), source: z.enum(["work", "task"]),
});
export const livePreviewErrorSchema = z.object({ message: z.string().max(6000), revision: z.number().int().nonnegative(), state: z.literal("error") });
