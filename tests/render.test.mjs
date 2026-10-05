import { describe, expect, it, vi } from "vitest";
import { Renderer } from "../server/render.mjs";

const fakeServices = () => ({ auth: { issueInternal: () => "token" }, events: { subscribe: () => {} } });

describe("renderer browser lifecycle", () => {
  it("never closes the browser while a check or export page is open", async () => {
    const renderer = new Renderer(fakeServices());
    clearInterval(renderer.sweeper);
    const close = vi.fn();
    renderer.browserPromise = Promise.resolve({ close });
    renderer.lastUse = 0;
    renderer.openPages = 1; // e.g. a long export, not in the warm-page map
    renderer.sweep();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    renderer.openPages = 0;
    renderer.sweep();
    await new Promise((resolve) => setTimeout(resolve));
    expect(close).toHaveBeenCalledOnce();
  });
});
