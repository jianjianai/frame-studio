/**
 * Scripts that run inside a web page, for both logged-in browsers: the server's (Playwright
 * evaluates the functions) and the user's own (the FRAME 连接器 extension evaluates their source
 * through the DevTools protocol). Each one is self-contained — no closures, plain JSON in and out —
 * because the extension gets it as text.
 */

/** The page's visible text. */
export function pageText() {
  return document.body?.innerText ?? "";
}

/** Links (address → text), once each. */
export function pageLinks() {
  const seen = new Map();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.href;
    if (!/^https?:/.test(href)) continue;
    const text = (anchor.innerText || anchor.getAttribute("aria-label") || anchor.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!seen.has(href) || (!seen.get(href) && text)) seen.set(href, text);
  }
  return [...seen].map(([href, text]) => ({ href, text }));
}

/** Pictures, videos and sounds of the page with their sizes, and what the page declares (og:). */
export function pageMedia() {
  const items = [];
  const add = (kind, src, extra = {}) => src && items.push({ kind, src, ...extra });
  for (const image of document.images) add("图片", image.currentSrc || image.src, { size: image.naturalWidth ? `${image.naturalWidth}×${image.naturalHeight}` : "", text: image.alt || "" });
  for (const video of document.querySelectorAll("video"))
    add("视频", video.currentSrc || video.src || video.querySelector("source")?.src, {
      size: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "",
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
      poster: video.poster || "",
    });
  for (const audio of document.querySelectorAll("audio")) add("音频", audio.currentSrc || audio.src || audio.querySelector("source")?.src);
  for (const meta of document.querySelectorAll('meta[property="og:image"], meta[property="og:video"], meta[property="og:audio"]'))
    add(meta.getAttribute("property").replace("og:", "页面声明的"), meta.content);
  return items;
}

/**
 * Where typing would go: an ordinary field, a password, a login form, or a box for writing
 * prose (comments, posts) — the last three are the user's to fill in.
 */
export function fieldKind(element) {
  const form = element.closest("form");
  const visiblePassword = (root) => [...root.querySelectorAll('input[type="password"]')].some((input) => input.offsetParent !== null);
  if (element.tagName === "INPUT") {
    if (element.type === "password") return "password";
    if (!["text", "search", "url", "email", "tel", "number", ""].includes(element.type)) return "other";
    return form && visiblePassword(form) ? "login" : "field";
  }
  const role = element.getAttribute("role");
  const search = role === "searchbox" || role === "combobox" || element.closest('[role="search"], search');
  if (element.tagName === "TEXTAREA" || element.isContentEditable) return search ? "field" : "prose";
  return "other";
}

/** Whether what has the focus takes typing (so a phone can bring up its keyboard). */
export function editableFocus() {
  const element = document.activeElement;
  if (!element) return false;
  if (element.tagName === "IFRAME") return true;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"].includes(element.type);
}

/**
 * The page's outline for the user's own browser, which has no Playwright snapshot: headings,
 * landmarks and everything that can be clicked or typed into, in page order, each of the latter
 * with a [ref=e…] (also written on the element as data-frame-ref, replacing the last outline's).
 * Goes into open shadow roots and same-site frames. Password fields show no value.
 */
export function pageOutline() {
  const ATTRIBUTE = "data-frame-ref";
  const INTERACTIVE = new Set(["link", "button", "combobox", "textbox", "searchbox", "checkbox", "radio", "slider", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "spinbutton", "file"]);
  const clean = (text, length = 80) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, length);
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = element.tagName;
    if (tag === "A") return element.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const type = element.type;
      if (type === "hidden") return null;
      if (type === "search") return "searchbox";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (["checkbox", "radio", "range", "file"].includes(type)) return { range: "slider" }[type] ?? type;
      return "textbox";
    }
    if (element.isContentEditable && !element.parentElement?.isContentEditable) return "textbox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return element.alt ? "img" : null;
    if (tag === "VIDEO") return "video";
    if (tag === "DIALOG") return "dialog";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "FORM") return "form";
    if (tag === "IFRAME") return "iframe";
    return null;
  };
  const nameOf = (element) => {
    const labelled = element.getAttribute("aria-labelledby");
    const byIds = labelled
      ? labelled
          .split(/\s+/)
          .map((id) => element.ownerDocument.getElementById(id)?.innerText || "")
          .join(" ")
      : "";
    const value = element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type) ? element.value : "";
    return clean(
      element.getAttribute("aria-label") ||
        byIds ||
        element.labels?.[0]?.innerText ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("alt") ||
        value ||
        (["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) ? "" : element.innerText),
    );
  };
  const visible = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
  };
  const lines = [];
  let next = 1;
  let visited = 0;
  const walk = (root, depth) => {
    for (const element of root.querySelectorAll ? root.children : []) {
      if (++visited > 30000 || lines.length > 3000) return;
      element.removeAttribute(ATTRIBUTE);
      const role = roleOf(element);
      let inner = depth;
      if (role && visible(element)) {
        const name = nameOf(element);
        const parts = [`${"  ".repeat(depth)}- ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""}`];
        if (role === "heading") parts.push(`[level=${element.tagName.slice(1) || element.getAttribute("aria-level") || ""}]`);
        if (INTERACTIVE.has(role)) {
          const ref = `e${next++}`;
          element.setAttribute(ATTRIBUTE, ref);
          parts.push(`[ref=${ref}]`);
        }
        if (element.disabled || element.getAttribute("aria-disabled") === "true") parts.push("[disabled]");
        if (element.checked || element.getAttribute("aria-checked") === "true") parts.push("[checked]");
        if (element.tagName === "INPUT" && element.type === "password") parts.push("（密码框）");
        else if (["textbox", "searchbox", "combobox"].includes(role) && element.value) parts.push(`: ${clean(element.value, 60)}`);
        if (role === "link") {
          const href = element.getAttribute("href") || "";
          if (href && !href.startsWith("javascript:")) parts.push(`→ ${clean(element.href, 120)}`);
        }
        lines.push(parts.join(" "));
        // Landmarks and dialogs group what is inside them.
        if (["navigation", "main", "form", "dialog", "iframe"].includes(role)) inner = depth + 1;
      }
      if (element.shadowRoot) walk(element.shadowRoot, inner);
      if (element.tagName === "IFRAME") {
        let inside = null;
        try {
          inside = element.contentDocument;
        } catch {}
        if (inside?.body) walk(inside.body, inner);
        else if (visible(element)) lines.push(`${"  ".repeat(inner)}- （另一个网站的内嵌页面，内容读不到）`);
      }
      walk(element, inner);
    }
  };
  for (const element of document.querySelectorAll(`[${ATTRIBUTE}]`)) element.removeAttribute(ATTRIBUTE);
  if (document.body) walk(document.body, 0);
  return lines.join("\n");
}

/** The element of an outline's ref (in open shadow roots and same-site frames too), or null. */
export function findRef(ref) {
  const search = (root) => {
    const found = root.querySelector(`[data-frame-ref="${ref}"]`);
    if (found) return found;
    for (const element of root.querySelectorAll("*")) {
      let inside = element.shadowRoot;
      if (!inside && element.tagName === "IFRAME")
        try {
          inside = element.contentDocument;
        } catch {}
      const deeper = inside && search(inside);
      if (deeper) return deeper;
    }
    return null;
  };
  return search(document);
}

/** Where to click an element: its center in the top page's CSS pixels, after scrolling it into view. */
export function elementPoint(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  // An element in a frame: add where each frame sits in its parent.
  for (let view = element.ownerDocument.defaultView; view && view.frameElement; view = view.parent) {
    const frame = view.frameElement.getBoundingClientRect();
    x += frame.left + view.frameElement.clientLeft;
    y += frame.top + view.frameElement.clientTop;
  }
  return { x, y, width: rect.width, height: rect.height };
}

/** Focus a field and select what is in it, so typed text replaces it. */
export function focusField(element) {
  element.focus();
  if (typeof element.select === "function") element.select();
  else if (element.isContentEditable) element.ownerDocument.execCommand("selectAll");
  return true;
}

/** Pick an option of a select by its text (or value). */
export function chooseOption(element, text) {
  const option = [...(element.options ?? [])].find((item) => item.text.trim() === text || item.value === text);
  if (!option) return { ok: false, options: [...(element.options ?? [])].map((item) => item.text.trim()).slice(0, 30) };
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}
