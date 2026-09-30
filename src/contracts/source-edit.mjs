import { z } from "zod";
const path = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceEditRequestSchema = z.strictObject({
  changes: z.array(z.strictObject({
    path, expectedSha256: digest.nullable(), content: z.string().max(1048576).nullable(),
  })).min(1).max(20),
  dryRun: z.boolean().default(false),
});
export const sourcePatchRequestSchema = z.strictObject({
  changes: z.array(z.strictObject({
    path, expectedSha256: digest,
    replacements: z.array(z.strictObject({
      find: z.string().min(1).max(1048576), replace: z.string().max(1048576),
      count: z.number().int().min(1).max(1000).default(1),
    })).min(1).max(50),
  })).min(1).max(20),
  dryRun: z.boolean().default(false),
});
