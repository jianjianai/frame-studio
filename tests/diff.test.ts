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

  it("marks the characters that changed between a removed line and the line that replaced it", () => {
    const [file] = parseDiff(
      [
        "diff --git a/经验/开场.md b/经验/开场.md",
        "@@ -1,3 +1,3 @@",
        "-- 开场前三秒必须给出问题，画面以明亮的暖色调为主。🎬",
        "-完全不同的一行",
        "+- 开场前一秒必须给出问题，画面以柔和的冷色调为主。🎞",
        "+另外写的内容在这里",
        " 不变",
      ].join("\n"),
    );
    const [first, second, third, fourth] = file.lines.slice(1);
    const marked = (line: (typeof file.lines)[number]) => line.marks?.map(([start, end]) => line.text.slice(start, end));
    expect(marked(first)).toEqual(["三", "明亮的暖", "🎬"]); // one kept character between changes joins them
    expect(marked(third)).toEqual(["一", "柔和的冷", "🎞"]);
    // Lines that share almost nothing are shown whole.
    expect(second.marks).toBeUndefined();
    expect(fourth.marks).toBeUndefined();
  });
});
