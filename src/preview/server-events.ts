// ---- server events over one WebSocket (/api/ws), kept alive ----
export type ServerEvent = { type: string; [key: string]: unknown };
type Listener = (event: ServerEvent) => void;

/**
 * A page's connection to the studio's events. It connects on the first subscription and comes
 * back by itself: after a close, and after silence, since a connection can die without closing
 * (a computer that slept, a changed network, a tab the browser froze) while the server ticks
 * every 20 s. Listeners get a local `reconnected` event when a dropped connection is made again:
 * what happened meanwhile was missed.
 */
export function serverEvents() {
  const listeners = new Set<Listener>();
  const statusListeners = new Set<(connected: boolean) => void>();
  let socket: WebSocket | null = null;
  let connected = false;
  let queue: string[] = [];
  /** When the server last said anything. */
  let heard = 0;
  /** The connection dropped since the page first connected. */
  let dropped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    clearTimeout(retry);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    socket = ws;
    ws.onopen = () => {
      connected = true;
      heard = Date.now();
      statusListeners.forEach((listener) => listener(true));
      if (dropped) listeners.forEach((listener) => listener({ type: "reconnected" }));
      dropped = false;
      for (const message of queue) ws.send(message);
      queue = [];
    };
    ws.onmessage = (message) => {
      heard = Date.now();
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.type === "tick") return;
      listeners.forEach((listener) => listener(event));
    };
    ws.onclose = () => lost(ws);
  }

  /** The connection is gone: say so once and connect again. */
  function lost(ws: WebSocket) {
    if (socket !== ws) return;
    socket = null;
    if (connected) statusListeners.forEach((listener) => listener(false));
    connected = false;
    dropped = true;
    retry = setTimeout(connect, 1500);
  }

  /** Silence longer than a few ticks: drop the connection and make it again at once. */
  function check(quiet: number) {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - heard < quiet) return;
    ws.onclose = ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    lost(ws);
    clearTimeout(retry);
    connect();
  }
  if (typeof window !== "undefined") {
    setInterval(() => check(45000), 10000);
    // Back in front, back online, out of the browser's freezer: check sooner.
    const soon = () => check(25000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon());
    document.addEventListener("resume", soon);
    window.addEventListener("online", soon);
    window.addEventListener("pageshow", soon);
  }

  return {
    send(event: ServerEvent) {
      const text = JSON.stringify(event);
      if (socket?.readyState === WebSocket.OPEN) socket.send(text);
      else queue = [...queue.slice(-20), text];
    },
    subscribe(listener: Listener) {
      if (!socket) connect();
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onConnection(listener: (connected: boolean) => void) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
  };
}
