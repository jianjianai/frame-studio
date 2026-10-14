import { describe, it, expect } from "vitest";
import { Tasks } from "../server/tasks.mjs";
import { Events } from "../server/util.mjs";

describe("tasks", () => {
  it("publishes what a task knows besides its progress (an export's time left and speed)", async () => {
    const events = new Events();
    const seen = [];
    events.subscribe((event) => seen.push(event.task));
    const tasks = new Tasks(events);
    const task = tasks.start({ kind: "export", title: "导出 测试" }, async ({ progress }) => {
      progress(0.5, "渲染画面 15/30", { eta: 12, fps: 30 });
      return { name: "a.mp4" };
    });
    expect((await tasks.wait(task.id)).status).toBe("done");
    expect(seen.find((item) => item.progress === 0.5)).toMatchObject({ message: "渲染画面 15/30", eta: 12, fps: 30, status: "running" });
  });
});
