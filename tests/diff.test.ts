import { describe, expect, it } from "vitest";
import { parseDiff } from "../web/workbench/diff";

describe("diff tab parser", () => {
  it("numbers old and new lines per file", () => {
    const files = parseDiff(
      [
        "diff --git a/projects/w/scene.ts b/projects/w/scene.ts",
        "index 1..2 100644",
        "--- a/projects/w/scene.ts",
        "+++ b/projects/w/scene.ts",
        "@@ -3,3 +3,3 @@ export",
        " keep",
        "-old",
        "+new",
        " tail",
        "diff --git a/projects/w/new.ts b/projects/w/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/projects/w/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
      ].join("\n"),
    );
    expect(files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["projects/w/scene.ts", 1, 1],
      ["projects/w/new.ts", 1, 0],
    ]);
    expect(files[0].lines.slice(1)).toEqual([
      { kind: "same", old: 3, new: 3, text: "keep" },
      { kind: "del", old: 4, text: "old" },
      { kind: "add", new: 4, text: "new" },
      { kind: "same", old: 5, new: 5, text: "tail" },
    ]);
  });
});
