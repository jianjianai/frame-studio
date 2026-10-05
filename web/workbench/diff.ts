export interface DiffLine {
  kind: "add" | "del" | "same" | "hunk";
  old?: number;
  new?: number;
  text: string;
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
  return files;
}
