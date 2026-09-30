import { describe, expect, it } from "vitest";
import { MediaRequestQueue } from "../../src/engine/media-buffering";

describe("media download scheduling", () => {
  it("prioritizes imminent chunks across tracks and caps simultaneous work", async () => {
    const queue = new MediaRequestQueue(2),
      signal = new AbortController().signal;
    const order: number[] = [],
      release: (() => void)[] = [];
    let active = 0,
      peak = 0;
    const jobs = [8, 10, 12, 2, 4, 6].map((priority) =>
      queue.run(
        signal,
        async () => {
          order.push(priority);
          peak = Math.max(peak, ++active);
          await new Promise<void>((resolve) => release.push(resolve));
          active--;
        },
        priority,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([2, 4]);
    while (order.length < jobs.length || active) {
      release.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(jobs);
    expect(order).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
  it("never starts cancelled queued downloads and releases slots on network failure", async () => {
    const queue = new MediaRequestQueue(1),
      aborted = new AbortController();
    let requested = false;
    const abandoned = queue.run(aborted.signal, async () => {
      requested = true;
    });
    const rejected = expect(abandoned).rejects.toMatchObject({
      name: "AbortError",
    });
    aborted.abort();
    await rejected;
    expect(requested).toBe(false);
    await expect(
      queue.run(new AbortController().signal, async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(
      await queue.run(new AbortController().signal, async () => "recovered"),
    ).toBe("recovered");
  });
});
