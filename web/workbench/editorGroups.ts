/**
 * Editor groups as in VS Code: the editor area is a grid of groups, each with its own tabs
 * (editors) and active tab; one group has the focus. Pure functions over that state, so the
 * component only renders it and the rules can be tested.
 */
export interface Editor {
  /** This tab; the same document can be open in several groups, each its own editor. */
  id: string;
  /** The document it shows ("preview" is the film's preview). */
  key: string;
  /** Markdown, an HTML page or a Lottie animation shown rendered instead of as source. */
  rendered?: boolean;
  line?: number;
}
export interface Group {
  id: string;
  editors: Editor[];
  active: string | null;
}
export type Layout = { group: string } | { direction: "row" | "column"; children: Layout[]; sizes: number[] };
export interface EditorState {
  groups: Record<string, Group>;
  layout: Layout;
  focus: string;
}
export type Side = "left" | "right" | "up" | "down";
export type Zone = Side | "center";

export function initialState(group: string, editor: Editor): EditorState {
  return { groups: { [group]: { id: group, editors: [editor], active: editor.id } }, layout: { group }, focus: group };
}

/** Groups in reading order (left to right, top to bottom). */
export function groupOrder(layout: Layout): string[] {
  return "group" in layout ? [layout.group] : layout.children.flatMap(groupOrder);
}

/** The groups that have an editor of the document. */
export function groupsWith(state: EditorState, key: string) {
  return groupOrder(state.layout).filter((id) => state.groups[id].editors.some((editor) => editor.key === key));
}

/** The editors on screen: the active one of every group. */
export function visibleEditors(state: EditorState) {
  return groupOrder(state.layout).flatMap((id) => {
    const group = state.groups[id];
    const editor = group.editors.find((item) => item.id === group.active);
    return editor ? [{ group: id, editor }] : [];
  });
}

const withGroup = (state: EditorState, group: Group): EditorState => ({ ...state, groups: { ...state.groups, [group.id]: group } });

/**
 * Open a document in a group: an editor of it there is activated, else a new one is added after
 * the active tab (never in place of another). The group gets the focus.
 */
export function openEditor(state: EditorState, groupId: string, editor: Editor, options: { index?: number } = {}): EditorState {
  const group = state.groups[groupId];
  const existing = group.editors.find((item) => item.key === editor.key);
  if (existing) {
    const kept = { ...existing, line: editor.line ?? existing.line };
    return {
      ...withGroup(state, { ...group, editors: group.editors.map((item) => (item.id === existing.id ? kept : item)), active: existing.id }),
      focus: groupId,
    };
  }
  const at = Math.max(0, Math.min(options.index ?? group.editors.findIndex((item) => item.id === group.active) + 1, group.editors.length));
  const editors = [...group.editors.slice(0, at), editor, ...group.editors.slice(at)];
  return { ...withGroup(state, { ...group, editors, active: editor.id }), focus: groupId };
}

export function activate(state: EditorState, groupId: string, editorId: string): EditorState {
  return { ...withGroup(state, { ...state.groups[groupId], active: editorId }), focus: groupId };
}

export function updateEditor(state: EditorState, groupId: string, editorId: string, change: Partial<Editor>): EditorState {
  const group = state.groups[groupId];
  return withGroup(state, { ...group, editors: group.editors.map((item) => (item.id === editorId ? { ...item, ...change } : item)) });
}

/** Take an editor out of its group; the group goes when it is left empty (never the last one). */
function detach(state: EditorState, groupId: string, editorId: string, keepGroup?: string): EditorState {
  const group = state.groups[groupId];
  const index = group.editors.findIndex((item) => item.id === editorId);
  if (index < 0) return state;
  const editors = group.editors.filter((item) => item.id !== editorId);
  // The tab beside it takes its place, as in VS Code.
  const active = group.active === editorId ? (editors[Math.min(index, editors.length - 1)]?.id ?? null) : group.active;
  const next = withGroup(state, { ...group, editors, active });
  if (editors.length || groupId === keepGroup || groupOrder(state.layout).length === 1) return next;
  return removeGroup(next, groupId);
}

export function closeEditor(state: EditorState, groupId: string, editorId: string): EditorState {
  return detach(state, groupId, editorId);
}

/**
 * Move an editor into another group (or to another place in its own), at `index` or after the
 * active tab. An editor of the same document already there takes its place. Pass `copy` to leave
 * the original where it is.
 */
export function moveEditor(state: EditorState, from: string, editorId: string, to: string, options: { index?: number; copy?: string } = {}): EditorState {
  const editor = state.groups[from]?.editors.find((item) => item.id === editorId);
  if (!editor || !state.groups[to]) return state;
  if (from === to) {
    if (options.copy || options.index === undefined) return activate(state, to, editorId);
    const group = state.groups[to];
    const without = group.editors.filter((item) => item.id !== editorId);
    const old = group.editors.findIndex((item) => item.id === editorId);
    const at = Math.max(0, Math.min(old < options.index ? options.index - 1 : options.index, without.length));
    return { ...withGroup(state, { ...group, editors: [...without.slice(0, at), editor, ...without.slice(at)], active: editorId }), focus: to };
  }
  const moved: Editor = { ...editor, id: options.copy ?? editor.id };
  const target = state.groups[to];
  const twin = target.editors.find((item) => item.key === editor.key);
  let next = options.copy ? state : detach(state, from, editorId, to);
  if (twin) return activate(next, to, twin.id);
  const group = next.groups[to];
  const at = Math.max(0, Math.min(options.index ?? group.editors.findIndex((item) => item.id === group.active) + 1, group.editors.length));
  next = withGroup(next, { ...group, editors: [...group.editors.slice(0, at), moved, ...group.editors.slice(at)], active: moved.id });
  return { ...next, focus: to };
}

/** A new empty group beside `target` (left, right, above or below it). */
export function splitGroup(state: EditorState, target: string, side: Side, groupId: string): EditorState {
  const direction = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "up";
  const leaf: Layout = { group: groupId };
  const visit = (node: Layout): Layout => {
    if ("group" in node) return node.group === target ? { direction, children: before ? [leaf, node] : [node, leaf], sizes: [0.5, 0.5] } : node;
    const index = node.children.findIndex((child) => "group" in child && child.group === target);
    if (index >= 0 && node.direction === direction) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(before ? index : index + 1, 0, leaf);
      sizes.splice(index, 1, sizes[index] / 2, sizes[index] / 2);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return { ...state, layout: visit(state.layout), groups: { ...state.groups, [groupId]: { id: groupId, editors: [], active: null } } };
}

/**
 * Remove a group. Its room goes back to the group before it (or after it, when it was first):
 * the one it was most likely split from. Splits left with one child disappear.
 */
export function removeGroup(state: EditorState, groupId: string): EditorState {
  const order = groupOrder(state.layout);
  if (order.length === 1 || !state.groups[groupId]) return state;
  const visit = (node: Layout): Layout | null => {
    if ("group" in node) return node.group === groupId ? null : node;
    const kept: Layout[] = [];
    const sizes: number[] = [];
    let freed = 0;
    let gone = -1;
    node.children.forEach((child, index) => {
      const next = visit(child);
      if (next) {
        kept.push(next);
        sizes.push(node.sizes[index]);
      } else {
        freed += node.sizes[index];
        gone = kept.length;
      }
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0];
    if (gone >= 0) sizes[Math.max(0, gone - 1)] += freed;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    // A child split the same way as this one merges into it.
    const children: Layout[] = [];
    const flat: number[] = [];
    kept.forEach((child, index) => {
      const share = sizes[index] / total;
      if (!("group" in child) && child.direction === node.direction) {
        child.children.forEach((inner, j) => {
          children.push(inner);
          flat.push(share * child.sizes[j]);
        });
      } else {
        children.push(child);
        flat.push(share);
      }
    });
    return { direction: node.direction, children, sizes: flat };
  };
  const layout = visit(state.layout) ?? { group: order.find((id) => id !== groupId)! };
  const groups = { ...state.groups };
  delete groups[groupId];
  const index = order.indexOf(groupId);
  const focus = state.focus === groupId ? order[index === 0 ? 1 : index - 1] : state.focus;
  return { groups, layout, focus };
}

/** The split at `path` (child indexes from the root). */
function splitAt(layout: Layout, path: number[]) {
  let node = layout;
  for (const index of path) {
    if ("group" in node) return null;
    node = node.children[index];
  }
  return "group" in node ? null : node;
}

/** Drag the border after child `index` of the split at `path` by `delta` (a share of the split), keeping each side at least `min`. */
export function resizeSplit(state: EditorState, path: number[], index: number, delta: number, min = 0.1): EditorState {
  const split = splitAt(state.layout, path);
  if (!split || index < 0 || index >= split.children.length - 1) return state;
  const sizes = [...split.sizes];
  const room = sizes[index] + sizes[index + 1];
  const lower = Math.min(min, room / 2);
  sizes[index] = Math.max(lower, Math.min(room - lower, sizes[index] + delta));
  sizes[index + 1] = room - sizes[index];
  const replace = (node: Layout, depth: number): Layout => {
    if ("group" in node) return node;
    if (depth === path.length) return { ...node, sizes };
    return { ...node, children: node.children.map((child, i) => (i === path[depth] ? replace(child, depth + 1) : child)) };
  };
  return { ...state, layout: replace(state.layout, 0) };
}

/** Even sizes for the split at `path` (a double-click on its border). */
export function evenSplit(state: EditorState, path: number[]): EditorState {
  const split = splitAt(state.layout, path);
  if (!split) return state;
  const sizes = split.children.map(() => 1 / split.children.length);
  const replace = (node: Layout, depth: number): Layout => {
    if ("group" in node) return node;
    if (depth === path.length) return { ...node, sizes };
    return { ...node, children: node.children.map((child, i) => (i === path[depth] ? replace(child, depth + 1) : child)) };
  };
  return { ...state, layout: replace(state.layout, 0) };
}

/** Rename a document everywhere (a moved file). */
export function renameKey(state: EditorState, from: string, to: string): EditorState {
  const groups: Record<string, Group> = {};
  for (const [id, group] of Object.entries(state.groups))
    groups[id] = { ...group, editors: group.editors.map((item) => (item.key === from ? { ...item, key: to } : item)) };
  return { ...state, groups };
}

/**
 * Where a drop at (x, y) in a group of `width`×`height` goes, as in VS Code: the outer thirds
 * split towards their side (left and right first), the middle moves the editor into the group.
 */
export function dropZone(x: number, y: number, width: number, height: number, canSplit = true): Zone {
  if (!canSplit) return "center";
  if (x < width / 3) return "left";
  if (x > (width * 2) / 3) return "right";
  if (y < height / 3) return "up";
  if (y > (height * 2) / 3) return "down";
  return "center";
}
