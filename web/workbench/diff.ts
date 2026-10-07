export interface DiffLine {
  kind: "add" | "del" | "same" | "hunk";
  old?: number;
  new?: number;
  text: string;
  /** The parts of a changed line that differ from the line it replaced: [start, end) string offsets. */
  marks?: [number, number][];
}
export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Unified git diff → files with old/new line numbers (VS Code's inline diff view). */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0,
    newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"), lines: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") file.path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (/^(index |--- |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      file.lines.push({ kind: "add", new: newLine++, text: line.slice(1) });
      file.added++;
    } else if (line.startsWith("-")) {
      file.lines.push({ kind: "del", old: oldLine++, text: line.slice(1) });
      file.removed++;
    } else if (line.startsWith(" ")) file.lines.push({ kind: "same", old: oldLine++, new: newLine++, text: line.slice(1) });
    else if (line.startsWith("Binary files")) file.lines.push({ kind: "hunk", text: "二进制文件已更改" });
  }
  for (const item of files) markChanges(item.lines);
  return files;
}

/**
 * In a run of removed lines followed by added ones, the n-th removed line is taken to have
 * become the n-th added one; both get the characters that differ marked, so a few changed
 * words stand out in a long (wrapped) line. Lines that differ almost entirely are left unmarked.
 */
export function markChanges(lines: DiffLine[]) {
  for (let index = 0; index < lines.length; ) {
    if (lines[index].kind !== "del") {
      index++;
      continue;
    }
    let dels = index;
    while (dels < lines.length && lines[dels].kind === "del") dels++;
    let adds = dels;
    while (adds < lines.length && lines[adds].kind === "add") adds++;
    for (let n = 0; n < Math.min(dels - index, adds - dels); n++) {
      const before = lines[index + n];
      const after = lines[dels + n];
      const marks = changedRanges(before.text, after.text);
      if (marks) [before.marks, after.marks] = marks;
    }
    index = adds;
  }
}

const LCS_LIMIT = 4_000_000; // cells of the comparison table; longer middles are marked whole

/** Character ranges that differ between two versions of a line, or null when they barely match. */
export function changedRanges(a: string, b: string): [[number, number][], [number, number][]] | null {
  // Code points, so a mark never splits a surrogate pair; `at` maps them back to string offsets.
  const x = Array.from(a);
  const y = Array.from(b);
  const offsets = (chars: string[]) => {
    const at = [0];
    for (const char of chars) at.push(at[at.length - 1] + char.length);
    return at;
  };
  const ax = offsets(x);
  const ay = offsets(y);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const n = x.length - start - end;
  const m = y.length - start - end;
  // Which characters of the middles are kept (longest common subsequence).
  const keptX = new Uint8Array(n);
  const keptY = new Uint8Array(m);
  let common = start + end;
  if (n && m && n * m <= LCS_LIMIT) {
    const table = new Uint32Array((n + 1) * (m + 1));
    const cell = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[cell(i, j)] = x[start + i] === y[start + j] ? table[cell(i + 1, j + 1)] + 1 : Math.max(table[cell(i + 1, j)], table[cell(i, j + 1)]);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (x[start + i] === y[start + j]) {
        keptX[i++] = 1;
        keptY[j++] = 1;
        common++;
      } else if (table[cell(i + 1, j)] >= table[cell(i, j + 1)]) i++;
      else j++;
    }
  }
  // Mostly different lines read better whole.
  if (common < 3 || common < Math.max(x.length, y.length) * 0.4) return null;
  const ranges = (kept: Uint8Array, at: number[]) => {
    const runs: [number, number][] = [];
    for (let i = 0; i < kept.length; ) {
      if (kept[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < kept.length && !kept[j]) j++;
      // One kept character between two changes is noise: join them.
      const last = runs[runs.length - 1];
      if (last && i - last[1] <= 1) last[1] = j;
      else runs.push([i, j]);
      i = j;
    }
    return runs.map(([i, j]): [number, number] => [at[start + i], at[start + j]]);
  };
  return [ranges(keptX, ax), ranges(keptY, ay)];
}
