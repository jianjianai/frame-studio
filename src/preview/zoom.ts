/**
 * Looking closer at a picture (the stage's canvas, an image in a tab) as in an image viewer:
 * Ctrl/⌘/Alt + wheel or a pinch zooms at the pointer, a drag (or the wheel, once zoomed in)
 * moves the view, a double click or double tap goes between fitted and actual size, and
 * Ctrl + = / - / 0 work while the keyboard is inside. The picture keeps its fitted layout and
 * what it renders; the zoom is only a transform on top.
 */

/** Scale relative to the fitted size; x/y move the picture's middle from where it was fitted (CSS px). */
export interface View {
  scale: number;
  x: number;
  y: number;
}
export interface ZoomState {
  /** 1: fitted, not zoomed. */
  scale: number;
  /** Of the picture's full-size pixels (`natural`), when known. */
  percent: number | null;
}
export interface Zoom {
  state(): ZoomState;
  zoomBy(factor: number): void;
  /** Fitted ↔ actual size (twice the fitted size when that is about the same), at the point given. */
  toggle(clientX?: number, clientY?: number): void;
  reset(): void;
  dispose(): void;
}
export interface ZoomOptions {
  /** The picture's full size, e.g. the work's composition; defaults to its own pixels. */
  natural?: () => { width: number; height: number } | null | undefined;
  /** Where Ctrl + = / - / 0 zoom (while the keyboard focus is inside it). */
  keys?: EventTarget;
  onChange?: (state: ZoomState) => void;
}

/** Zoom to `scale` keeping the point `at` (from the picture's fitted middle) over the same spot of the picture. */
export function zoomAround(view: View, scale: number, at: { x: number; y: number }): View {
  const k = scale / view.scale;
  return { scale, x: at.x - k * (at.x - view.x), y: at.y - k * (at.y - view.y) };
}

/**
 * Larger than the box along an axis, the picture moves only until its edge meets the box's;
 * smaller, it stays where it was fitted (or as near as it fits). `half`: half its zoomed size,
 * `before`/`after`: from its fitted middle to the box's edges.
 */
function clampAxis(offset: number, half: number, before: number, after: number) {
  const low = after - half;
  const high = half - before;
  return low <= high ? Math.min(high, Math.max(low, offset)) : Math.min(low, Math.max(high, 0));
}
export function clampView(
  view: View,
  size: { width: number; height: number },
  box: { left: number; right: number; top: number; bottom: number },
): View {
  if (view.scale <= 1) return { scale: 1, x: 0, y: 0 };
  return {
    scale: view.scale,
    x: clampAxis(view.x, (size.width * view.scale) / 2, box.left, box.right),
    y: clampAxis(view.y, (size.height * view.scale) / 2, box.top, box.bottom),
  };
}

const STYLE = `
.frame-zoom-box { touch-action: none; }
.frame-zoom-box.frame-zoomed { cursor: grab; user-select: none; -webkit-user-select: none; }
.frame-zoom-box.frame-zoom-dragging { cursor: grabbing; }
.frame-zoom-hud {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  display: flex; align-items: center; gap: 2px; padding: 2px;
  border-radius: 6px; background: rgb(24 24 28 / 0.78); color: #fff;
  font: 12px/1 system-ui, sans-serif; box-shadow: 0 1px 4px rgb(0 0 0 / 0.3);
  cursor: default; user-select: none; -webkit-user-select: none;
}
.frame-zoom-hud[hidden] { display: none; }
.frame-zoom-hud button {
  min-width: 24px; height: 22px; padding: 0 6px; border: 0; border-radius: 4px;
  background: none; color: inherit; font: inherit; cursor: pointer;
}
.frame-zoom-hud button:hover { background: rgb(255 255 255 / 0.16); }
.frame-zoom-hud span { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
`;

/** A mouse wheel moves by about 100 a notch; a trackpad pinch by a few at a time. */
const wheelFactor = (delta: number) => Math.exp(-delta * (Math.abs(delta) >= 50 ? 0.002 : 0.01));

/** Zoom `picture` inside `box`, which clips it (and positions the zoom controls). */
export function attachZoom(box: HTMLElement, picture: HTMLElement, options: ZoomOptions = {}): Zoom {
  const doc = box.ownerDocument;
  if (!doc.getElementById("frame-zoom-style")) {
    const style = doc.createElement("style");
    style.id = "frame-zoom-style";
    style.textContent = STYLE;
    doc.head.append(style);
  }
  box.classList.add("frame-zoom-box");
  let view: View = { scale: 1, x: 0, y: 0 };
  let reported = "";

  const pixels = () => (picture instanceof HTMLCanvasElement ? picture.width : picture instanceof HTMLImageElement ? picture.naturalWidth : 0);
  /** The scale at which one full-size pixel is one CSS pixel. */
  const actual = () => {
    const width = options.natural?.()?.width || pixels();
    return width && picture.offsetWidth ? width / picture.offsetWidth : 0;
  };
  const limit = () => Math.max(8, actual() * 16);
  /** The picture's fitted middle on screen: its layout, which the transform does not change. */
  const middle = () => {
    const parent = (picture.offsetParent as HTMLElement | null) ?? box;
    const rect = parent.getBoundingClientRect();
    return {
      x: rect.left + parent.clientLeft + picture.offsetLeft + picture.offsetWidth / 2,
      y: rect.top + parent.clientTop + picture.offsetTop + picture.offsetHeight / 2,
    };
  };
  const state = (): ZoomState => {
    const width = options.natural?.()?.width || pixels();
    return { scale: view.scale, percent: width ? (picture.offsetWidth * view.scale * 100) / width : null };
  };

  const hud = doc.createElement("div");
  hud.className = "frame-zoom-hud";
  hud.hidden = true;
  const label = doc.createElement("span");
  const button = (text: string, title: string, run: () => void) => {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.title = title;
    element.addEventListener("click", run);
    return element;
  };
  hud.append(
    button("−", "缩小 (Ctrl + -)", () => zoomAt(view.scale / 1.25, undefined, undefined, true)),
    label,
    button("+", "放大 (Ctrl + =)", () => zoomAt(view.scale * 1.25, undefined, undefined, true)),
    button("适应", "适应窗口 (Ctrl + 0，或双击画面)", () => reset()),
  );
  box.append(hud);

  const apply = (animate = false) => {
    const rect = box.getBoundingClientRect();
    const center = middle();
    view = clampView(
      view,
      { width: picture.offsetWidth, height: picture.offsetHeight },
      { left: center.x - rect.left, right: rect.right - center.x, top: center.y - rect.top, bottom: rect.bottom - center.y },
    );
    const zoomed = view.scale > 1;
    picture.style.transition = animate ? "transform 0.18s ease-out" : "";
    picture.style.transform = zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : "";
    // Close up, show the pixels as they are rather than blurred.
    const perPixel = (picture.offsetWidth * view.scale * devicePixelRatio) / (pixels() || Infinity);
    picture.style.imageRendering = perPixel >= 4 ? "pixelated" : "";
    box.classList.toggle("frame-zoomed", zoomed);
    hud.hidden = !zoomed;
    const now = state();
    label.textContent = now.percent ? `${Math.round(now.percent)}%` : `${now.scale.toFixed(1)}×`;
    const key = `${now.scale.toFixed(4)}|${now.percent?.toFixed(1)}`;
    if (key !== reported) {
      reported = key;
      options.onChange?.(now);
    }
  };
  const zoomAt = (scale: number, clientX?: number, clientY?: number, animate = false) => {
    const rect = box.getBoundingClientRect();
    const center = middle();
    const at = { x: (clientX ?? (rect.left + rect.right) / 2) - center.x, y: (clientY ?? (rect.top + rect.bottom) / 2) - center.y };
    view = zoomAround(view, Math.max(1, Math.min(limit(), scale)), at);
    apply(animate);
  };
  const pan = (dx: number, dy: number) => {
    if (view.scale <= 1) return;
    view = { ...view, x: view.x + dx, y: view.y + dy };
    apply();
  };
  const reset = () => {
    view = { scale: 1, x: 0, y: 0 };
    apply(true);
  };
  const toggle = (clientX?: number, clientY?: number) => {
    if (view.scale > 1.001) return reset();
    const full = actual();
    zoomAt(full > 1.25 ? full : 2, clientX, clientY, true);
  };

  // ---- input ----------------------------------------------------------------------
  // Only on the picture or the bare box: the zoom controls, and scrolling text over the
  // picture (the stage's warnings), keep their own input.
  const mine = (target: EventTarget | null) => target === box || target === picture;
  const points = new Map<number, { x: number; y: number; type: string }>();
  let pinch: { distance: number; x: number; y: number } | null = null;
  /** A touch that may be a tap: where and when it went down, and the previous tap. */
  let press: { x: number; y: number; time: number; still: boolean } | null = null;
  let lastTap: { x: number; y: number; time: number } | null = null;
  let lastPointer = "mouse";
  let gesture = 0;
  /** The first two fingers' distance and middle. */
  const spread = () => {
    const [a, b] = [...points.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const down = (event: PointerEvent) => {
    lastPointer = event.pointerType;
    if (!mine(event.target)) return;
    const mouse = event.pointerType === "mouse";
    // A mouse drags only when there is something to move (or with the middle button, as a hand tool).
    if (mouse && !(event.button === 1 || (event.button === 0 && view.scale > 1))) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    try {
      box.setPointerCapture(event.pointerId);
    } catch {}
    press = points.size === 1 && !mouse ? { x: event.clientX, y: event.clientY, time: Date.now(), still: true } : null;
    pinch = points.size >= 2 ? spread() : null;
    if (view.scale > 1) box.classList.add("frame-zoom-dragging");
  };
  const move = (event: PointerEvent) => {
    const point = points.get(event.pointerId);
    if (!point) return;
    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) press.still = false;
    if (points.size >= 2) {
      const next = spread();
      if (pinch && pinch.distance > 0) {
        // The picture follows the fingers' middle and grows with their spread.
        view = { ...view, x: view.x + next.x - pinch.x, y: view.y + next.y - pinch.y };
        zoomAt((view.scale * next.distance) / pinch.distance, next.x, next.y);
      }
      pinch = next;
    } else pan(dx, dy);
  };
  const up = (event: PointerEvent) => {
    if (!points.delete(event.pointerId)) return;
    pinch = points.size >= 2 ? spread() : null;
    if (points.size) return;
    box.classList.remove("frame-zoom-dragging");
    // Two quick taps in the same place: like a double click.
    if (event.type === "pointerup" && press?.still && Date.now() - press.time < 300) {
      const now = Date.now();
      if (lastTap && now - lastTap.time < 350 && Math.hypot(lastTap.x - event.clientX, lastTap.y - event.clientY) < 30) {
        lastTap = null;
        toggle(event.clientX, event.clientY);
      } else lastTap = { x: event.clientX, y: event.clientY, time: now };
    }
    press = null;
  };
  const middleButton = (event: MouseEvent) => {
    // No autoscroll or paste for the hand tool.
    if (event.button === 1 && mine(event.target)) event.preventDefault();
  };
  const doubleClick = (event: MouseEvent) => {
    if (lastPointer === "mouse" && mine(event.target)) toggle(event.clientX, event.clientY);
  };
  const noDrag = (event: DragEvent) => {
    if (view.scale > 1) event.preventDefault();
  };
  const wheel = (event: WheelEvent) => {
    if (!mine(event.target)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // Also a trackpad pinch (a wheel with Ctrl); not the browser's page zoom.
      event.preventDefault();
      if (!gesture) zoomAt(view.scale * wheelFactor(dy), event.clientX, event.clientY);
    } else if (view.scale > 1) {
      event.preventDefault();
      if (event.shiftKey && !dx) pan(-dy, 0);
      else pan(-dx, -dy);
    }
  };
  // Safari's trackpad pinch (on iOS a touch pinch, which the pointers handle already).
  type Gesture = Event & { scale: number; clientX: number; clientY: number };
  const touching = () => [...points.values()].some((point) => point.type !== "mouse");
  const gestureStart = (event: Event) => {
    event.preventDefault();
    gesture = touching() ? 0 : view.scale;
  };
  const gestureChange = (event: Event) => {
    event.preventDefault();
    const { scale, clientX, clientY } = event as Gesture;
    if (gesture && !touching()) zoomAt(gesture * scale, clientX, clientY);
  };
  const gestureEnd = (event: Event) => {
    event.preventDefault();
    gesture = 0;
  };
  const key = (event: Event) => {
    const { ctrlKey, metaKey, altKey, key } = event as KeyboardEvent;
    if (!(ctrlKey || metaKey) || altKey) return;
    if (key === "=" || key === "+") zoomAt(view.scale * 1.25, undefined, undefined, true);
    else if (key === "-" || key === "_") zoomAt(view.scale / 1.25, undefined, undefined, true);
    else if (key === "0") reset();
    else return;
    event.preventDefault();
  };

  box.addEventListener("pointerdown", down);
  box.addEventListener("pointermove", move);
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);
  box.addEventListener("mousedown", middleButton);
  box.addEventListener("dblclick", doubleClick);
  box.addEventListener("dragstart", noDrag);
  box.addEventListener("wheel", wheel, { passive: false });
  box.addEventListener("gesturestart", gestureStart);
  box.addEventListener("gesturechange", gestureChange);
  box.addEventListener("gestureend", gestureEnd);
  options.keys?.addEventListener("keydown", key);
  // A resized box or picture (a new fitted size): stay inside it.
  const resized = new ResizeObserver(() => apply());
  resized.observe(box);
  resized.observe(picture);
  apply();

  return {
    state,
    zoomBy: (factor) => zoomAt(view.scale * factor, undefined, undefined, true),
    toggle,
    reset,
    dispose() {
      resized.disconnect();
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
      box.removeEventListener("mousedown", middleButton);
      box.removeEventListener("dblclick", doubleClick);
      box.removeEventListener("dragstart", noDrag);
      box.removeEventListener("wheel", wheel);
      box.removeEventListener("gesturestart", gestureStart);
      box.removeEventListener("gesturechange", gestureChange);
      box.removeEventListener("gestureend", gestureEnd);
      options.keys?.removeEventListener("keydown", key);
      hud.remove();
      box.classList.remove("frame-zoom-box", "frame-zoomed", "frame-zoom-dragging");
      picture.style.transform = picture.style.transition = picture.style.imageRendering = "";
    },
  };
}
