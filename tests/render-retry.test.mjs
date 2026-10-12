import { describe, expect, it } from "vitest";
import { again } from "../server/render.mjs";

describe("page calls during a Vite reload", () => {
  const page = () => {
    const calls = [];
    return { calls, waitForLoadState: async () => calls.push("load"), waitForFunction: async () => calls.push("ready") };
  };
  it("wait for the page and run once more", async () => {
    const p = page();
    let tries = 0;
    const result = await again(p, () => true, async () => {
      if (tries++ === 0) throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
      return "frame";
    });
    expect(result).toBe("frame");
    expect(p.calls).toEqual(["load", "ready"]);
  });
  it("pass other errors on, and fail when the second run fails too", async () => {
    await expect(again(page(), () => true, async () => Promise.reject(new Error("scene threw")))).rejects.toThrow("scene threw");
    await expect(again(page(), () => true, async () => Promise.reject(new Error("Execution context was destroyed")))).rejects.toThrow("Execution context");
  });
});
