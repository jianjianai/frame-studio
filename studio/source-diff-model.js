/** Parse only hunk bodies; filenames/headers are never interpreted as HTML or code. */
export function parsePatch(patch, limit = 4000) {
  const hunks = [];
  let current,
    oldLine = 0,
    newLine = 0,
    count = 0,
    added = 0,
    removed = 0,
    truncated = false;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      current = { header: text, lines: [] };
      if (count < limit) hunks.push(current);
      continue;
    }
    if (!current || !text || ![" ", "+", "-", "\\"].includes(text[0])) continue;
    const kind =
      text[0] === "+"
        ? "add"
        : text[0] === "-"
          ? "remove"
          : text[0] === "\\"
            ? "meta"
            : "context";
    if (kind === "add") added++;
    if (kind === "remove") removed++;
    const row = {
      kind,
      text: text.slice(1),
      oldLine: kind === "add" || kind === "meta" ? null : oldLine++,
      newLine: kind === "remove" || kind === "meta" ? null : newLine++,
    };
    if (++count <= limit) current.lines.push(row);
    else truncated = true;
  }
  return { hunks, added, removed, truncated };
}
/** Pair replacement blocks; context stays aligned and missing lines remain blank. */
export function splitRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.kind === "meta") {
      rows.push({ meta: line.text });
      i++;
    } else {
      const left = [],
        right = [];
      while (i < lines.length && ["add", "remove"].includes(lines[i].kind)) {
        const item = lines[i++];
        (item.kind === "remove" ? left : right).push(item);
      }
      for (let j = 0; j < Math.max(left.length, right.length); j++)
        rows.push({ left: left[j], right: right[j] });
    }
  }
  return rows;
}
