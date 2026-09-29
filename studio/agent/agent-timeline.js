const terminal = new Set(["succeeded", "failed", "cancelled", "publish_failed"]);
export const isAgentRunning = (phase) => phase === "running" || phase === "waiting";
const limit = (text, size = 128000) => String(text || "").slice(0, size);
/** Incremental reducer: items retain their FIRST position while snapshots and
 * deltas update their contents. No regrouping all prose before all tools.
 */
export function createAgentTimeline() {
  let ordered = [], byId = new Map(), processed = 0, firstRow = null, lastRow = null, legacyStream = null, usage = null;
  function update(rows = []) {
    if (rows.length < processed || (processed && (rows[0]?.id !== firstRow || rows[processed - 1]?.id !== lastRow))) {
      ordered = []; byId = new Map(); processed = 0; legacyStream = null; usage = null;
    }
    const put = (event, row) => {
      const old = byId.get(event.id);
      const value = { ...old, ...event, firstAt: old?.firstAt || event.at || row.created, lastAt: event.at || row.created, firstEvent: old?.firstEvent || row.id };
      if (event.delta !== undefined) {
        if (event.kind === "thinking" && event.summaryIndex !== undefined) {
          const parts = { ...old?.summaryParts, [event.summaryIndex]: limit((old?.summaryParts?.[event.summaryIndex] || "") + event.delta) };
          value.summaryParts = parts; value.text = Object.keys(parts).sort((a, b) => Number(a) - Number(b)).map((key) => parts[key]).join("\n\n");
        } else value.text = limit((old?.text || "") + event.delta);
        value.textTruncated = old?.textTruncated || (old?.text?.length || 0) + event.delta.length > 128000;
      }
      if (event.outputDelta !== undefined) {
        const combined = (old?.output || "") + event.outputDelta;
        value.output = combined.slice(-32000); value.outputTruncated = old?.outputTruncated || combined.length > 32000;
      }
      delete value.delta; delete value.outputDelta;
      if (!old) ordered.push(event.id);
      byId.set(event.id, value);
    };
    for (const row of rows.slice(processed)) {
      const e = row.data || {};
      if (row.kind === "agent-item" && typeof e.id === "string" && typeof e.kind === "string") { put(e, row); continue; }
      if (row.kind === "usage") { usage = { ...usage, ...e }; continue; }
      // Legacy event records remain readable, with their original order preserved.
      if (row.kind === "delta") {
        legacyStream ||= `legacy-stream:${row.id}`;
        put({ id: legacyStream, kind: "message", phase: "running", delta: e.text || "" }, row);
      } else if (row.kind === "message" || row.kind === "summary") {
        if (!e.text) continue;
        if (row.kind === "summary" && [...byId.values()].some((v) => v.kind === "message" && v.text === e.text)) continue;
        put({ id: legacyStream || `legacy-message:${e.id || row.id}`, kind: "message", phase: "completed", text: e.text }, row);
        legacyStream = null;
      } else if (row.kind === "activity") {
        const id = `legacy-activity:${e.id || row.id}`, old = byId.get(id);
        const kind = e.tool === "thinking" ? "thinking" : /command|shell|bash/i.test(e.tool || "") ? "command" : old?.kind || "tool";
        put({ id, kind, phase: Number.isInteger(e.exitCode) && e.exitCode !== 0 ? "failed" : e.phase === "done" ? "completed" : "running",
          title: e.tool === "result" && old ? old.title : e.text || e.tool || "工具调用",
          ...(e.output ? { output: e.output } : {}), ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
          ...(kind === "command" ? { command: e.text } : {}), legacy: true,
        }, row);
      } else if (row.kind === "error" || row.kind === "monitor-warning") put({ id: `legacy-notice:${row.id}`, kind: "notice", phase: "failed", title: row.kind === "error" ? "执行出错" : "状态同步异常", text: e.text || e.message }, row);
    }
    processed = rows.length; firstRow = rows[0]?.id; lastRow = rows.at(-1)?.id;
    return { items: ordered.map((id) => byId.get(id)), usage };
  }
  return { update };
}
export function effectiveAgentPhase(item, taskState) {
  if (!isAgentRunning(item.phase) || !terminal.has(taskState)) return item.phase || "completed";
  return taskState === "cancelled" ? "cancelled" : "ended";
}
export function groupAgentItems(items) {
  const groups = [];
  const hasQuestion = items.some((item) => item.kind === "question");
  for (const item of items) {
    if (item.cumulative) continue;
    // The human-input card IS the presentation of this tool call, not a second
    // unrelated card underneath a duplicate "waiting" tool row.
    if (hasQuestion && ["frame_ask_user", "AskUserQuestion"].includes(item.toolName)) continue;
    if (item.kind === "message" || item.kind === "question" || (item.kind === "notice" && item.phase === "failed")) {
      groups.push({ id: item.id, type: "item", item }); continue;
    }
    let group = groups.at(-1);
    if (group?.type !== "steps") { group = { id: "steps:" + item.id, type: "steps", items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}
export function latestAgentFiles(items) {
  const cumulative = items.filter((item) => item.kind === "files" && item.cumulative).sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0));
  const authoritative = cumulative.findLast((item) => item.source === "isolated-git") || cumulative.at(-1);
  if (authoritative) return { files: authoritative.files || [], truncated: authoritative.truncated, source: authoritative.source };
  const files = new Map();
  for (const item of items) if (item.kind === "files" && item.phase === "completed") for (const file of item.files || []) files.set(file.path, file);
  return { files: [...files.values()] };
}
export const searchableAgentItem = (item) => [item.title, item.text, item.command, item.output, item.error, ...(item.files || []).map((f) => f.path + "\n" + (f.diff || "")), JSON.stringify(item.input || ""), JSON.stringify(item.question?.payload || "")].filter(Boolean).join("\n");
