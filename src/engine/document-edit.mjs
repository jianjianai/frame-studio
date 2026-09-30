import { z } from "zod";
import { visualOperationSchema } from "./visual-document.mjs";
import { audioOperationSchema } from "./audio-document.mjs";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const visualEditRequestSchema = z.strictObject({
  expectedSha256: digest,
  operations: z.array(visualOperationSchema).min(1).max(100),
  dryRun: z.boolean().default(false),
});
export const audioEditRequestSchema = z.strictObject({
  expectedSha256: digest.nullable(),
  projectSha256: digest.optional(),
  operations: z.array(audioOperationSchema).min(1).max(100),
  dryRun: z.boolean().default(false),
});
