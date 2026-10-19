import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A WebSocket that does nothing on the wire: the test opens it, sends to it and stays silent. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send() {}
  close() {
    this.closed = true;
  }
}

describe("the studio's event connection", () => {
  const handlers = new Map<string, () => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeSocket.all = [];
    handlers.clear();
    const target = { addEventListener: (name: string, handler: () => void) => handlers.set(name, handler) };
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("window", target);
    vi.stubGlobal("document", { ...target, visibilityState: "visible" });
    vi.stubGlobal("location", { protocol: "https:", host: "frame.example" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops a connection that went silent without closing, connects again and says so", async () => {
    const { subscribe } = await import("../web/lib/api");
    const events: string[] = [];
    subscribe((event) => events.push(event.type));
    const first = FakeSocket.all[0];
    first.open();
    first.say({ type: "tick" });
    first.say({ type: "ai-event" });
    // Ticks are the connection's own: listeners only see real events.
    expect(events).toEqual(["ai-event"]);
    // The computer sleeps: no message, no close.
    vi.advanceTimersByTime(50000);
    expect(first.closed).toBe(true);
    const second = FakeSocket.all[1];
    expect(second?.url).toBe("wss://frame.example/api/ws");
    second.open();
    // What happened meanwhile never arrived: views load it again.
    expect(events).toEqual(["ai-event", "reconnected"]);
    // A connection that keeps talking stays.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20000);
      second.say({ type: "tick" });
    }
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("checks sooner when the page comes back to the front", async () => {
    const { subscribe } = await import("../web/lib/api");
    subscribe(() => {});
    FakeSocket.all[0].open();
    vi.setSystemTime(Date.now() + 30000);
    handlers.get("visibilitychange")?.();
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
  });
});
