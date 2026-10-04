import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
const schema = z.strictObject({ version: z.literal(1), secret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), environmentId: z.uuid() });
const pending = new Map();
/** Atomically publish shared identity. Concurrent FRAME processes never replace an existing secret. */
export async function aiControl(data) {
  const file = process.env.FRAME_AI_CONTROL_FILE || path.join(data, "ai/shared/control.json");
  if (pending.has(file)) return pending.get(file);
  const operation = (async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { return schema.parse(JSON.parse(await fs.readFile(file, "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = file + "." + randomUUID() + ".tmp";
    const value = { version: 1, secret: randomBytes(32).toString("base64url"), environmentId: randomUUID() };
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      try { await fs.link(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
      return schema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    } finally { await fs.rm(temporary, { force: true }); }
  })();
  pending.set(file, operation);
  try { return await operation; } catch (error) { if (pending.get(file) === operation) pending.delete(file); throw error; }
}
