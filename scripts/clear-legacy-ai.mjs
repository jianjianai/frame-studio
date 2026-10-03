import { database } from "../server/db.mjs";
import { clearLegacyAiFiles } from "../server/legacy-ai-cleanup.mjs";

// Run once during deployment after legacy workers stop. No backup is created.
const db = await database(process.env.DATABASE_URL, process.env.FRAME_ADMIN_PASSWORD);
try {
  console.log(JSON.stringify(await clearLegacyAiFiles({ db, data: process.env.FRAME_DATA || "/data" })));
} finally {
  await db.pool.end();
}
