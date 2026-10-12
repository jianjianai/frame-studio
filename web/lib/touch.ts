/**
 * Touch screens. A long press opens the context menu: Android fires `contextmenu` for one,
 * iOS Safari does not, so after a still press of LONG_PRESS ms a `contextmenu` event is sent to
 * the pressed element — every right-click menu of the studio then opens by a long press too.
 * Text fields keep their own long press (selection, paste). The mouse events and click a long
 * press may end with are dropped: the menu is what the press asked for.
 */
const LONG_PRESS = 500;
const SLOP = 10;

export function installTouchSupport() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let pressed = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || Boolean(target.closest(".cm-editor")));

  document.addEventListener(
    "touchstart",
    (event) => {
      cancel();
      pressed = false;
      if (event.touches.length !== 1 || typing(event.target)) return;
      const touch = event.touches[0];
      const target = event.target as Element;
      start = { x: touch.clientX, y: touch.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        pressed = true;
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start!.x, clientY: start!.y, button: 2 }));
        navigator.vibrate?.(8);
      }, LONG_PRESS);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      const touch = event.touches[0];
      if (!start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP) cancel();
    },
    { passive: true },
  );
  const end = () => {
    cancel();
    // Only the click right after the press is dropped.
    if (pressed) setTimeout(() => (pressed = false), 400);
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });
  // The browser's own long-press menu event (Android) came first: one menu is enough.
  document.addEventListener("contextmenu", (event) => event.isTrusted && cancel(), true);
  // The mouse events a browser may send for the released finger would close the menu (it closes
  // on mousedown elsewhere) or act on the pressed element: they go nowhere.
  const swallow = (event: Event) => {
    if (!pressed) return;
    if (event.type === "click") pressed = false;
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ["mousedown", "mouseup", "click"]) document.addEventListener(type, swallow, true);
}

/** Whether the main pointer is a finger (touch screen without a mouse). */
export const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
