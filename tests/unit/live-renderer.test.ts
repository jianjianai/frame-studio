import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameRenderer } from "../../src/engine/renderer";
import type { AnimationProject, Scene } from "../../src/engine/types";

class Surface {
  width = 320;
  height = 180;
  frame = "";
  parentElement = null;
  context = {
    fillStyle: "", fillRect: () => {},
    drawImage: (source: Surface) => { this.frame = source.frame; },
  };
  getContext() { return this.context; }
  toDataURL() { return this.frame; }
}
function scene(name: string, render?: (time: number) => void | Promise<void>) {
  const canvas = new Surface();
  const dispose = vi.fn();
  const value: Scene = {
    canvas: canvas as unknown as HTMLCanvasElement,
    render: async time => { await render?.(time); canvas.frame = name + ":" + time; },
    dispose,
  };
  return { value, dispose, canvas };
}
function project(value: Scene): AnimationProject {
  return {
    id: "live-test", title: "Live", subtitle: "", description: "", renderer: "canvas",
    duration: 60, fps: 30, accent: "#fff", poster: "", tags: [], status: "draft",
    beats: [], subtitles: [], credits: [], load: async () => ({ createScene: () => value }),
  };
}
function setup() {
  vi.stubGlobal("document", { createElement: () => new Surface() });
  const canvas = new Surface(), initial = scene("old");
  const output = new FrameRenderer(canvas as unknown as HTMLCanvasElement, project(initial.value));
  return { canvas, initial, output };
}
const options = (time = 4.5, signal?: AbortSignal) => ({
  width: 320, height: 180, quality: "standard" as const, time: () => time, subtitles: () => false, signal,
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("live renderer transactions", () => {
  it("refreshes a prepared candidate at the latest playhead before committing", async () => {
    const { output, canvas } = setup();
    await output.init(320, 180);
    let position = 3;
    const next = scene("new");
    const staged = await output.prepareProject(project(next.value), { ...options(), time: () => position });
    position = 8;
    await staged.refresh();
    expect(canvas.frame).toBe("old:0");
    expect(next.canvas.frame).toBe("new:8");
    staged.commit();
    expect(canvas.frame).toBe("new:8");
    output.dispose();
  });
  it("a failure preparing the final commit position keeps the previously visible scene intact", async () => {
    const { output, canvas, initial } = setup();
    await output.init(320, 180);
    let position = 3;
    const next = scene("new", time => { if (time > 5) throw Error("bad new position"); });
    const staged = await output.prepareProject(project(next.value), { ...options(), time: () => position });
    position = 8;
    await expect(staged.refresh()).rejects.toThrow("bad new position");
    staged.dispose();
    expect(canvas.frame).toBe("old:0");
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(next.dispose).toHaveBeenCalledTimes(1);
    output.dispose();
  });
  it("asynchronous media waits report buffering only after the grace interval and recover when the frame commits", async () => {
    vi.useFakeTimers();
    const { output, initial } = setup();
    await output.init(320, 180);
    const changes: boolean[] = [];
    output.onBuffering = waiting => changes.push(waiting);
    await output.render(1, false);
    expect(changes).toEqual([]);
    let finish: (() => void) | undefined;
    initial.value.prepareFrame = () => new Promise(resolve => { finish = resolve; });
    const pending = output.render(2, false);
    await vi.advanceTimersByTimeAsync(99);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(changes).toEqual([true]);
    finish!();
    await pending;
    expect(changes).toEqual([true, false]);
    output.dispose();
  });
  it("committing a ready replacement releases a stalled old frame's buffering ownership", async () => {
    vi.useFakeTimers();
    const { output, initial, canvas } = setup();
    await output.init(320, 180);
    const changes: boolean[] = [];
    output.onBuffering = waiting => changes.push(waiting);
    let finish: (() => void) | undefined;
    initial.value.prepareFrame = () => new Promise(resolve => { finish = resolve; });
    const oldFrame = output.render(2, false);
    await vi.advanceTimersByTimeAsync(101);
    const next = scene("new");
    const staged = await output.prepareProject(project(next.value), options(3));
    staged.commit();
    expect(changes).toEqual([true, false]);
    expect(canvas.frame).toBe("new:3");
    finish!();
    expect(await oldFrame).toBe(false);
    expect(changes).toEqual([true, false]);
    output.dispose();
  });

  it("keeps the last usable frame throughout preparation, commits at the requested position and releases only old ownership", async () => {
    const { output, canvas, initial } = setup();
    await output.init(320, 180);
    await output.render(4.5, false);
    const next = scene("new");
    const staged = await output.prepareProject(project(next.value), options());
    expect(canvas.frame).toBe("old:4.5");
    expect(next.canvas.frame).toBe("new:4.5");
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(staged.commit()).toBe(true);
    expect(canvas.frame).toBe("new:4.5");
    await output.settled();
    expect(initial.dispose).toHaveBeenCalledTimes(1);
    staged.dispose();
    expect(next.dispose).not.toHaveBeenCalled();
    expect(output.diagnostics().sceneEpoch).toBe(2);
    output.dispose();
    await output.settled(); await Promise.resolve();
    expect(next.dispose).toHaveBeenCalledTimes(1);
  });
  it("a candidate frame failure preserves output/project and immediately releases the candidate", async () => {
    const { output, canvas } = setup();
    await output.init(320, 180);
    await output.render(7, false);
    const next = scene("bad", () => { throw new Error("candidate failed"); });
    const oldProject = output.project;
    await expect(output.prepareProject(project(next.value), options(7))).rejects.toThrow("candidate failed");
    expect(canvas.frame).toBe("old:7");
    expect(output.project).toBe(oldProject);
    expect(next.dispose).toHaveBeenCalledTimes(1);
    expect(output.diagnostics().sceneEpoch).toBe(1);
    output.dispose();
  });
  it("an old asynchronous frame cannot overwrite a newly committed scene or release it", async () => {
    let unblock: (() => void) | undefined;
    const { output, canvas, initial } = setup();
    await output.init(320, 180);
    initial.value.prepareFrame = () => new Promise(resolve => { unblock = resolve; });
    const oldFrame = output.render(2, false);
    await Promise.resolve(); await Promise.resolve();
    const next = scene("new");
    const staged = await output.prepareProject(project(next.value), options(8));
    expect(staged.commit()).toBe(true);
    expect(canvas.frame).toBe("new:8");
    expect(initial.dispose).not.toHaveBeenCalled();
    unblock!();
    expect(await oldFrame).toBe(false);
    await Promise.resolve();
    expect(canvas.frame).toBe("new:8");
    expect(initial.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).not.toHaveBeenCalled();
    output.dispose();
  });
  it("stale ready candidates are disposed on cancellation and cannot commit", async () => {
    const { output, canvas } = setup();
    await output.init(320, 180);
    const cancel = new AbortController(), next = scene("cancelled");
    const staged = await output.prepareProject(project(next.value), options(5, cancel.signal));
    cancel.abort();
    expect(next.dispose).toHaveBeenCalledTimes(1);
    expect(staged.commit()).toBe(false);
    expect(canvas.frame).toBe("old:0");
    output.dispose();
  });
  it("a scene that finishes creating after session disposal is released without replacing the old frame", async () => {
    const { output, canvas } = setup();
    await output.init(320, 180);
    const next = scene("late");
    let created: ((value: Scene) => void) | undefined;
    const replacement = { ...project(next.value), load: async () => ({ createScene: () => new Promise<Scene>(resolve => { created = resolve; }) }) };
    const preparation = output.prepareProject(replacement, options());
    await Promise.resolve(); await Promise.resolve();
    output.dispose();
    created!(next.value);
    await expect(preparation).rejects.toBeDefined();
    expect(next.dispose).toHaveBeenCalledTimes(1);
    expect(canvas.frame).toBe("old:0");
  });
});
