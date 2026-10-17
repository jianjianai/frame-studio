/**
 * SVG-Edit (https://github.com/SVG-Edit/svgedit, MIT) in the studio's editor tab. The tab shows
 * this page in a sandboxed frame — an origin of its own, without the studio's session — and
 * passes the file's text by postMessage; this page sends back the text after each change and
 * asks the tab to save on Ctrl+S.
 *
 * SVG-Edit rewrites what it opens: paths in its own notation, attributes sorted, its canvas size
 * for the root's size, a layer around everything, ids on every shape, one space per level. The
 * text sent back undoes that wherever nothing was edited, so a change of one shape changes the
 * file only there.
 */

// An opaque origin has no storage, and the editor keeps its clipboard there: in memory instead.
for (const name of ["localStorage", "sessionStorage"]) {
  try {
    void window[name].length;
  } catch {
    const items = new Map();
    const storage = {
      get length() {
        return items.size;
      },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => (items.has(key) ? items.get(key) : null),
      setItem: (key, value) => void items.set(key, String(value)),
      removeItem: (key) => void items.delete(key),
      clear: () => items.clear(),
    };
    Object.defineProperty(window, name, { value: storage, configurable: true });
  }
}

const XMLNS = "http://www.w3.org/2000/xmlns/";
/** Numbers the file's elements while SVG-Edit opens them and while their text is taken. */
const MARK = "data-frame-mark";
/** The studio: this page's address, though its origin is opaque. */
const studio = new URL(location.href).origin;
const send = (message) => parent.postMessage({ svgEditor: true, ...message }, studio);

const { default: Editor } = await import("./Editor.js");
const editor = new Editor(document.getElementById("container"));
editor.setConfig({
  lang: "zh-CN",
  // Without storage (nothing to restore, nothing kept) and without opening or saving files: the tab does that.
  noDefaultExtensions: true,
  extensions: ["ext-eyedropper", "ext-grid", "ext-markers", "ext-panning", "ext-shapes", "ext-polystar", "ext-layer_view"],
  userExtensions: [],
  noStorageOnLoad: true,
  preventAllURLConfig: true,
  no_save_warning: true,
});
editor.init();
await editor.ready(() => {});
const canvas = editor.svgCanvas;

/**
 * The opened file: its prolog, root, ids, indent and its elements by number, with what SVG-Edit
 * wrote for each right after opening (`written`: its attributes and the whole element as text);
 * null until one is open.
 */
let original = null;
/** SVG-Edit's elements that came from the file, and their numbers. */
let marks = new WeakMap();
let timer = 0;

const attributesOf = (element) => [...element.attributes].map((item) => ({ ns: item.namespaceURI, name: item.name, local: item.localName, value: item.value }));

/** The file numbered for opening, with what it had; null when it is no SVG. */
function describe(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.localName !== "svg") return null;
  const elements = [...root.querySelectorAll("*")];
  elements.forEach((element, index) => element.setAttribute(MARK, String(index)));
  const marked = new XMLSerializer().serializeToString(root);
  for (const element of elements) element.removeAttribute(MARK);
  return {
    marked,
    prolog: /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*/.exec(text)[0].trim(),
    root: attributesOf(root),
    elements,
    ids: new Set(elements.map((element) => element.id).filter(Boolean)),
    layers: [...root.children].some((element) => element.localName === "g" && element.classList.contains("layer")),
    indent: /\n([ \t]+)</.exec(text)?.[1] ?? null,
    newline: /\n\s*$/.test(text),
  };
}

/** What SVG-Edit writes now, parsed, its elements from the file numbered. */
function written() {
  const numbered = [];
  for (const element of canvas.getSvgContent().querySelectorAll("*")) {
    const mark = marks.get(element);
    if (mark === undefined) continue;
    element.setAttribute(MARK, String(mark));
    numbered.push(element);
  }
  try {
    return new DOMParser().parseFromString(canvas.getSvgString(), "image/svg+xml");
  } finally {
    for (const element of numbered) element.removeAttribute(MARK);
  }
}

const sameAttributes = (a, b) => a.length === b.length && a.every((item) => b.some((other) => other.name === item.name && other.value === item.value));
const setAttributes = (element, attributes) => {
  for (const item of attributesOf(element)) element.removeAttributeNS(item.ns, item.local);
  for (const item of attributes) element.setAttributeNS(item.ns, item.name, item.value);
};

/** The outermost of the file's elements that SVG-Edit writes as it did when they were opened: nothing was done to them. */
function untouched(parent, found = new Set()) {
  for (const element of parent.children) {
    const mark = element.getAttribute(MARK);
    if (mark !== null && new XMLSerializer().serializeToString(element) === original.written.get(Number(mark))?.text) found.add(element);
    else untouched(element, found);
  }
  return found;
}

/** What nothing was done to comes back as the file had it: whole elements, else attributes; edited attributes keep the file's order. */
function restoreElements(parent, kept) {
  for (const element of [...parent.children]) {
    const mark = element.getAttribute(MARK);
    const before = mark === null ? null : original.written.get(Number(mark));
    if (kept.has(element)) {
      element.replaceWith(element.ownerDocument.importNode(original.elements[mark], true));
      continue;
    }
    if (before) {
      element.removeAttribute(MARK);
      const now = attributesOf(element);
      const had = attributesOf(original.elements[mark]);
      if (sameAttributes(now, before.attributes)) setAttributes(element, had);
      else {
        const order = had.map((item) => item.name);
        const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
        setAttributes(element, now.sort((a, b) => rank(a.name) - rank(b.name)));
      }
    }
    restoreElements(element, kept);
  }
}

const same = (a, b) => Math.abs(a - b) < 0.01;
const round = (value) => String(Math.round(value * 1000) / 1000);

/** SVG-Edit writes its canvas size as width/height and leaves out viewBox, x, y and id: back as the file had them. */
function restoreRoot(root) {
  const size = [Number(root.getAttribute("width")), Number(root.getAttribute("height"))];
  for (const name of ["width", "height", "viewBox", "x", "y", "id", "overflow"]) root.removeAttribute(name);
  if (!original.root.some((item) => item.name === "xmlns:svg")) root.removeAttributeNS(XMLNS, "svg");
  // Declared by SVG-Edit for namespaces it has no prefix for.
  root.removeAttributeNS(XMLNS, "undefined");
  // The file's namespaces (xlink, inkscape…), which the elements given back their attributes may use.
  for (const item of original.root) if (item.ns === XMLNS && !root.hasAttributeNS(XMLNS, item.local)) root.setAttributeNS(XMLNS, item.name, item.value);
  const had = new Map(original.root.map((item) => [item.name, item.value]));
  for (const name of ["id", "x", "y", "overflow"]) if (had.has(name)) root.setAttribute(name, had.get(name));
  const box = had.get("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (same(size[0], original.size[0]) && same(size[1], original.size[1])) {
    for (const name of ["viewBox", "width", "height"]) if (had.has(name)) root.setAttribute(name, had.get(name));
  } else if (box?.length === 4) {
    // Resized in 文档属性 (in user units): the viewBox grows with it and the size keeps its scale.
    const scaled = (value, from, to) => {
      const match = /^\s*([\d.eE+-]+)\s*([a-z]*)\s*$/.exec(value);
      return match && from ? round((Number(match[1]) * to) / from) + match[2] : value;
    };
    root.setAttribute("viewBox", [box[0], box[1], round(size[0]), round(size[1])].join(" "));
    if (had.has("width")) root.setAttribute("width", scaled(had.get("width"), box[2], size[0]));
    if (had.has("height")) root.setAttribute("height", scaled(had.get("height"), box[3], size[1]));
  } else {
    root.setAttribute("width", round(size[0]));
    root.setAttribute("height", round(size[1]));
  }
  // In the file's order, anything new after.
  const order = original.root.map((item) => item.name);
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  setAttributes(root, attributesOf(root).sort((a, b) => rank(a.name) - rank(b.name)));
}

/** SVG-Edit puts a drawing without layers into one: out again, unless the file had layers or more were made. */
function unwrapLayer(root) {
  if (original.layers) return;
  const layers = [...root.children].filter((element) => element.localName === "g" && element.classList.contains("layer"));
  const [layer] = layers;
  // A hidden or locked layer keeps what it says.
  if (layers.length !== 1 || layer.attributes.length !== 1) return;
  const blank = (node) => node?.nodeType === Node.TEXT_NODE && !node.data.trim();
  const title = [...layer.children].find((element) => element.localName === "title");
  if (blank(title?.previousSibling)) title.previousSibling.remove();
  title?.remove();
  if (blank(layer.lastChild)) layer.lastChild.remove();
  if (blank(layer.previousSibling)) layer.previousSibling.remove();
  // One level less deep (SVG-Edit indents by a space).
  const walker = root.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (blank(node)) node.data = node.data.replace(/\n /g, "\n");
  while (layer.firstChild) root.insertBefore(layer.firstChild, layer);
  layer.remove();
}

/** The ids SVG-Edit gave shapes to tell them apart: gone again unless something refers to one. */
function dropGeneratedIds(root) {
  const generated = new RegExp(`^${canvas.getIdPrefix().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`);
  const elements = [root, ...root.querySelectorAll("*")];
  const used = new Set();
  for (const element of elements) {
    for (const attribute of element.attributes) {
      for (const match of attribute.value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) used.add(match[1]);
      if (attribute.localName === "href" && attribute.value.startsWith("#")) used.add(attribute.value.slice(1));
    }
    if (element.localName === "style") for (const match of element.textContent.matchAll(/#([\w-]+)/g)) used.add(match[1]);
  }
  for (const element of elements) if (generated.test(element.id) && !original.ids.has(element.id) && !used.has(element.id)) element.removeAttribute("id");
}

/** The file's indent (two spaces, a tab…) for SVG-Edit's one space a level. */
function reindent(root) {
  if (!original.indent) return;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.data.trim()) node.data = node.data.replace(/\n( *)/g, (_, spaces) => "\n" + original.indent.repeat(spaces.length));
}

function exportText() {
  const root = written().documentElement;
  const kept = untouched(root);
  // SVG-Edit's own layout first; what comes back from the file brings its own.
  unwrapLayer(root);
  reindent(root);
  restoreElements(root, kept);
  dropGeneratedIds(root);
  restoreRoot(root);
  const text = new XMLSerializer().serializeToString(root);
  return (original.prolog ? original.prolog + "\n" : "") + text + (original.newline ? "\n" : "");
}

/** The text now, or null when every change was undone (the file as it was). */
function flush() {
  clearTimeout(timer);
  timer = 0;
  if (original) send({ type: "change", text: canvas.undoMgr.getUndoStackSize() > 0 ? exportText() : null });
}

async function load(text) {
  original = null;
  clearTimeout(timer);
  const described = describe(text);
  if (!described) return send({ type: "error", message: "这个文件不是有效的 SVG，切换到「代码」修改" });
  try {
    await editor.loadFromString(described.marked, { noAlert: true });
  } catch {
    return send({ type: "error", message: "SVG 编辑器打不开这个文件，切换到「代码」修改" });
  }
  marks = new WeakMap();
  for (const element of canvas.getSvgContent().querySelectorAll(`[${MARK}]`)) {
    marks.set(element, Number(element.getAttribute(MARK)));
    element.removeAttribute(MARK);
  }
  const { w, h } = canvas.getResolution();
  original = { ...described, size: [w, h], written: new Map() };
  for (const element of written().querySelectorAll(`[${MARK}]`)) {
    const text = new XMLSerializer().serializeToString(element);
    original.written.set(Number(element.getAttribute(MARK)), { text, attributes: attributesOf(element).filter((item) => item.name !== MARK) });
  }
  canvas.undoMgr.resetUndoStack();
  editor.zoomChanged(window, "canvas");
  send({ type: "loaded" });
}

// Each change (a drag ends, an attribute is set, an undo) sends the text, a few at a time.
const changed = canvas.bind("changed", (...args) => {
  changed?.(...args);
  if (!original) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
});
// What is selected, for the AI ("这个"): the file's own ids, else the kind of shape.
const selected = canvas.bind("selected", (...args) => {
  selected?.(...args);
  if (!original) return;
  const items = (args[1] ?? []).filter(Boolean).map((element) => (original.ids.has(element.id) ? `#${element.id}` : `<${element.localName}>`));
  send({ type: "selection", items: [...new Set(items)] });
});

// SVG-Edit's canvas keeps a press from moving the focus, which would leave its shortcuts (and
// Ctrl+S) with the studio around the frame: the frame takes the focus itself.
window.addEventListener("pointerdown", () => document.hasFocus() || window.focus(), true);
window.addEventListener(
  "keydown",
  (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      flush();
      send({ type: "save" });
    }
  },
  true,
);
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== studio) return;
  if (event.data?.type === "load") void load(String(event.data.text));
});
send({ type: "ready" });
