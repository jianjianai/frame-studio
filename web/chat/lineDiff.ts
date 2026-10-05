export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Line diff via LCS; large inputs fall back to "all removed / all added". */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const head = a.slice(0, start).map((text) => ({ type: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ type: "same" as const, text }));
  if (midA.length * midB.length > 250000)
    return [...head, ...midA.map((text) => ({ type: "del" as const, text })), ...midB.map((text) => ({ type: "add" as const, text })), ...tail];
  const rows = midA.length + 1,
    cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
  const middle: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ type: "same", text: midA[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) middle.push({ type: "del", text: midA[i++] });
    else middle.push({ type: "add", text: midB[j++] });
  }
  while (i < midA.length) middle.push({ type: "del", text: midA[i++] });
  while (j < midB.length) middle.push({ type: "add", text: midB[j++] });
  return [...head, ...middle, ...tail];
}

/** Keep changed lines with a little context; collapse long unchanged runs. */
export function compactDiff(lines: DiffLine[], context = 2) {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.type !== "same") for (let k = index - context; k <= index + context; k++) keep.add(k);
  });
  const out: (DiffLine | { type: "gap"; count: number })[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (gap) out.push({ type: "gap", count: gap });
      gap = 0;
      out.push(line);
    } else gap++;
  });
  if (gap) out.push({ type: "gap", count: gap });
  return out;
}
