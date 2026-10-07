/**
 * Helpers for tools that take several items in one call: each item is done on its own (a
 * few at a time), one failing does not stop the others, and the AI gets one line per item
 * so it can retry exactly the ones that failed.
 */

/** Results in item order: { ok: true, value } or { ok: false, error }. */
export async function eachSettled(items, task, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await task(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** "完成 3 项，失败 1 项" followed by one line per item. */
export function summarize(results, describe) {
  const failed = results.filter((result) => !result.ok).length;
  const head = failed ? `完成 ${results.length - failed} 项，失败 ${failed} 项（只需重试失败的）：` : `全部完成（${results.length} 项）：`;
  return [head, ...results.map((result, index) => describe(result, index))].join("\n");
}

/** A tool error as data for one item: message, plus code and details when there are any. */
export const errorOf = (error) => ({ message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
