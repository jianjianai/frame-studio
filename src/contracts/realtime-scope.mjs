import { z } from "zod";
export const notificationSchema = z.object({
  table: z.string().regex(/^[a-z_]{1,60}$/),
  repo: z.string().uuid().nullish(),
  work: z.string().uuid().nullish(),
  task: z.string().uuid().nullish(),
  chat: z.string().uuid().nullish(),
  project: z.string().max(64).nullish(),
});
/** @typedef {import("zod").infer<typeof notificationSchema>} Change */
/** @typedef {{repo?: string, project?: string, work?: string, task?: string, chat?: string}} Scope */
/** Invalid notifications conservatively resynchronize; legacy table names still work. @param {string | null} payload @returns {Change | null} */
export function decodeNotification(payload) {
  if (payload === null) return null;
  if (/^[a-z_]{1,60}$/.test(payload)) return { table: payload };
  try {
    const parsed = notificationSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** @param {Change | null} change @param {string[]} tables @param {Scope} scope */
export function notificationMatches(change, tables, scope = {}) {
  if (change === null) return true;
  if (!tables.includes(change.table)) return false;
  for (const key of /** @type {const} */ ([
    "repo",
    "project",
    "work",
    "task",
    "chat",
  ]))
    if (scope[key] && change[key] && scope[key] !== change[key]) return false;
  return true;
}
