import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chunkPath = z.string().regex(/^assets\/[A-Za-z0-9_.-]+\.js$/).max(1000);
const mediaPath = z.string().max(4096).refine(value => /^films\/[a-z][a-z0-9-]*\//.test(value) && !value.split("/").includes("..") && !/[?#\\]/.test(value));
export const livePreviewMediaModeSchema = z.enum(["original", "compressed", "cached"]);
const resourcePath = z.string().max(4096).refine(value =>
  /^(?:assets|vendor|fonts)\//.test(value) || mediaPath.safeParse(value).success
).refine(value => !value.split("/").includes("..") && !/[?#\\]/.test(value));
export const livePreviewResourceSchema = z.object({
  path: resourcePath, url: z.string().max(8192), originalUrl: z.string().max(8192),
  revision: hash, sha256: hash, bytes: z.number().int().nonnegative(),
  type: z.string().min(1).max(200), kind: z.enum(["module", "media", "runtime"]),
}).refine(value => value.revision === value.sha256);
export const livePreviewManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(200),
  workId: z.string().uuid().optional(),
  projectId: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64).optional(),
  revision: z.number().int().positive(),
  sourceRevision: hash,
  compiledRevision: hash.optional(),
  source: z.literal("work"),
  projectUrl: chunkPath,
  mediaModes: z.array(livePreviewMediaModeSchema).max(3).default(["original", "compressed", "cached"]),
  defaultMediaMode: livePreviewMediaModeSchema.default("compressed"),
  resources: z.array(livePreviewResourceSchema).max(20000).default([]),
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
  revision: z.literal(0), state: z.literal("starting"), source: z.literal("work"),
});
export const livePreviewErrorSchema = z.object({ message: z.string().max(6000), revision: z.number().int().nonnegative(), state: z.literal("error") });
