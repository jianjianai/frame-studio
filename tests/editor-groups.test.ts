import { describe, expect, it } from "vitest";
import {
  closeEditor,
  dropZone,
  evenSplit,
  groupOrder,
  initialState,
  moveEditor,
  openEditor,
  removeGroup,
  renameKey,
  resizeSplit,
  splitGroup,
  visibleEditors,
  type EditorState,
} from "../web/workbench/editorGroups";

const tabs = (state: EditorState, group: string) => state.groups[group].editors.map((editor) => editor.key);

describe("editor groups", () => {
  it("opens documents as tabs, a preview replacing the previous preview", () => {
    let state = initialState("g1", { id: "p", key: "preview" });
    state = openEditor(state, "g1", { id: "a", key: "a.ts", preview: true });
    state = openEditor(state, "g1", { id: "b", key: "b.ts", preview: true });
    expect(tabs(state, "g1")).toEqual(["preview", "b.ts"]);
    state = openEditor(state, "g1", { id: "c", key: "c.ts" });
    // Opening one that is open activates it, and keeps it unless asked as a preview.
    state = openEditor(state, "g1", { id: "x", key: "b.ts" });
    expect(state.groups.g1).toMatchObject({ active: "b" });
    expect(state.groups.g1.editors.find((editor) => editor.id === "b")?.preview).toBe(false);
    expect(tabs(state, "g1")).toEqual(["preview", "b.ts", "c.ts"]);
  });

  it("splits by dragging a tab to a side, merges splits of the same direction, and closes empty groups", () => {
    let state = initialState("g1", { id: "p", key: "preview" });
    state = openEditor(state, "g1", { id: "a", key: "a.ts" });
    state = openEditor(state, "g1", { id: "b", key: "b.ts" });
    // a.ts to the right of the preview.
    state = splitGroup(state, "g1", "right", "g2");
    state = moveEditor(state, "g1", "a", "g2");
    expect(state.layout).toEqual({ direction: "row", children: [{ group: "g1" }, { group: "g2" }], sizes: [0.5, 0.5] });
    expect([tabs(state, "g1"), tabs(state, "g2"), state.focus]).toEqual([["preview", "b.ts"], ["a.ts"], "g2"]);
    // b.ts below a.ts, then c beside g2 on the right: the row takes it, no nested row.
    state = splitGroup(state, "g2", "down", "g3");
    state = moveEditor(state, "g1", "b", "g3");
    expect(state.layout).toEqual({
      direction: "row",
      children: [{ group: "g1" }, { direction: "column", children: [{ group: "g2" }, { group: "g3" }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
    state = splitGroup(state, "g1", "right", "g4");
    expect(groupOrder(state.layout)).toEqual(["g1", "g4", "g2", "g3"]);
    expect("group" in state.layout ? [] : state.layout.sizes).toEqual([0.25, 0.25, 0.5]);
    state = removeGroup(state, "g4");
    // Moving a.ts out empties g2: it goes, and the column with one child left goes too.
    state = moveEditor(state, "g2", "a", "g3", { index: 0 });
    expect(state.groups.g2).toBeUndefined();
    expect(state.layout).toEqual({ direction: "row", children: [{ group: "g1" }, { group: "g3" }], sizes: [0.5, 0.5] });
    expect(tabs(state, "g3")).toEqual(["a.ts", "b.ts"]);
    // Closing the last tabs of a group closes it; the last group stays.
    state = closeEditor(state, "g3", "a");
    state = closeEditor(state, "g3", "b");
    expect(state.layout).toEqual({ group: "g1" });
    expect(state.focus).toBe("g1");
    expect(closeEditor(state, "g1", "p").groups.g1.editors).toEqual([]);
  });

  it("copies an editor, takes the place of a twin, reorders within a group and shows each group's active tab", () => {
    let state = initialState("g1", { id: "p", key: "preview" });
    state = openEditor(state, "g1", { id: "a", key: "a.ts" });
    state = openEditor(state, "g1", { id: "b", key: "b.ts" });
    state = splitGroup(state, "g1", "left", "g2");
    state = moveEditor(state, "g1", "a", "g2", { copy: "a2" });
    expect([tabs(state, "g1"), tabs(state, "g2")]).toEqual([["preview", "a.ts", "b.ts"], ["a.ts"]]);
    expect(groupOrder(state.layout)).toEqual(["g2", "g1"]);
    // The same document moved onto its twin: the twin is shown, no second tab.
    state = moveEditor(state, "g1", "a", "g2");
    expect([tabs(state, "g1"), tabs(state, "g2"), state.groups.g2.active]).toEqual([["preview", "b.ts"], ["a.ts"], "a2"]);
    state = moveEditor(state, "g1", "b", "g1", { index: 0 });
    expect(tabs(state, "g1")).toEqual(["b.ts", "preview"]);
    state = moveEditor(state, "g1", "b", "g1", { index: 2 });
    expect(tabs(state, "g1")).toEqual(["preview", "b.ts"]);
    expect(visibleEditors(state).map(({ group, editor }) => [group, editor.key])).toEqual([
      ["g2", "a.ts"],
      ["g1", "b.ts"],
    ]);
    state = renameKey(state, "a.ts", "c.ts");
    expect(tabs(state, "g2")).toEqual(["c.ts"]);
  });

  it("resizes splits within limits and finds where a drop goes", () => {
    let state = initialState("g1", { id: "p", key: "preview" });
    state = splitGroup(state, "g1", "right", "g2");
    state = resizeSplit(state, [], 0, 0.2);
    expect("group" in state.layout ? [] : state.layout.sizes.map((size) => Math.round(size * 100))).toEqual([70, 30]);
    state = resizeSplit(state, [], 0, 0.5, 0.15);
    expect("group" in state.layout ? [] : state.layout.sizes.map((size) => Math.round(size * 100))).toEqual([85, 15]);
    state = evenSplit(state, []);
    expect("group" in state.layout ? [] : state.layout.sizes).toEqual([0.5, 0.5]);
    expect([
      dropZone(10, 50, 300, 100),
      dropZone(290, 50, 300, 100),
      dropZone(150, 10, 300, 100),
      dropZone(150, 90, 300, 100),
      dropZone(150, 50, 300, 100),
    ]).toEqual(["left", "right", "up", "down", "center"]);
    expect(dropZone(10, 50, 300, 100, false)).toBe("center");
  });
});
