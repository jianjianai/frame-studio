/** Bound each transport message by bytes as well as row count. Large diffs must
 * not turn 100 events into a many-megabyte websocket frame. */
export async function agentEventPage(db, task, after = 0) {
  const events = await db.all(
    `WITH page AS (
    SELECT * FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT 101
  ), measured AS (
    SELECT page.*, sum(octet_length(data::text)+256) OVER (ORDER BY id) AS bytes,
      row_number() OVER (ORDER BY id) AS position FROM page
  ) SELECT id,task,kind,data,created,source_offset FROM measured
    WHERE bytes<=786432 OR position=1 ORDER BY id LIMIT 100`,
    [task, after],
  );
  const cursor = events.at(-1)?.id || after;
  const next = await db.one(
    "SELECT id FROM events WHERE task=$1 AND id>$2 ORDER BY id LIMIT 1",
    [task, cursor],
  );
  return { events, hasMore: !!next };
}
