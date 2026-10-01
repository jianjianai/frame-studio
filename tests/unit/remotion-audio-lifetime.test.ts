import { describe, expect, it, vi } from "vitest";
import { retireRemotionAudio } from "../../src/engine/remotion-audio-lifetime";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

class Context extends EventTarget {
  state: AudioContextState;
  pending: ReturnType<typeof deferred>[] = [];
  suspend = vi.fn(() => {
    const request = deferred();
    this.pending.push(request);
    return request.promise;
  });
  close = vi.fn(async () => this.change("closed"));
  resume = vi.fn(async () => this.change("running"));
  constructor(state: AudioContextState = "suspended") {
    super();
    this.state = state;
  }
  change(state: AudioContextState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
  notify() {
    this.dispatchEvent(new Event("statechange"));
  }
}

const retire = (context: Context) =>
  retireRemotionAudio(
    context as Pick<
      AudioContext,
      "state" | "suspend" | "addEventListener" | "removeEventListener"
    >,
  );

describe("retired Remotion audio context lifetime", () => {
  it("guards an initially suspended context when a previously pending native resume finishes later", async () => {
    const context = new Context();
    const add = vi.spyOn(context, "addEventListener");
    retire(context);
    expect(context.suspend).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith("statechange", expect.any(Function));

    // A resume already requested by the discarded Player can finish after its disposal.
    context.change("running");
    expect(context.suspend).toHaveBeenCalledTimes(1);
    context.change("suspended");
    context.pending[0].resolve();
    await settle();

    // Suspension must keep the local guard alive for another late native resume.
    context.change("running");
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("suspended");
    context.pending[1].resolve();
    await settle();
    expect(context.close).not.toHaveBeenCalled();
    expect(context.resume).not.toHaveBeenCalled();
    context.change("closed");
  });

  it("coalesces running events and suspends again if a late resume wins before the first suspend settles", async () => {
    const context = new Context("running");
    retire(context);
    expect(context.suspend).toHaveBeenCalledTimes(1);
    context.notify();
    context.notify();
    context.change("suspended");
    context.change("running");
    expect(context.suspend).toHaveBeenCalledTimes(1);

    // Native suspension fulfilled, but another resume has already restored running.
    context.pending[0].resolve();
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.notify();
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("suspended");
    context.pending[1].resolve();
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("closed");
  });

  it("removes only its own listener when the context closes during an in-flight suspension", async () => {
    const context = new Context("running");
    const unrelated = vi.fn();
    context.addEventListener("statechange", unrelated);
    const remove = vi.spyOn(context, "removeEventListener");
    retire(context);
    context.change("closed");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toBe("statechange");
    expect(remove.mock.calls[0][1]).not.toBe(unrelated);

    context.pending[0].resolve();
    await settle();
    context.notify();
    expect(context.suspend).toHaveBeenCalledTimes(1);
    expect(unrelated).toHaveBeenCalledTimes(2);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("does not retry rejected suspensions in microtasks but retries a later running state transition", async () => {
    const context = new Context("running");
    retire(context);
    context.pending[0].reject(Error("native suspension rejected"));
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(1);

    context.change("suspended");
    context.change("running");
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("suspended");
    context.pending[1].resolve();
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("closed");
  });

  it("handles a synchronous suspension failure without spinning and allows a later running transition", async () => {
    const context = new Context("running");
    context.suspend.mockImplementationOnce(() => {
      throw Error("native suspension threw");
    });
    expect(() => retire(context)).not.toThrow();
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(1);

    context.change("suspended");
    context.change("running");
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("suspended");
    context.pending[0].resolve();
    await settle();
    expect(context.suspend).toHaveBeenCalledTimes(2);
    context.change("closed");
  });

  it("leaves an independent active Frame context and its state listeners untouched", async () => {
    const retired = new Context("running");
    const activeFrame = new Context("running");
    const activeListener = vi.fn();
    activeFrame.addEventListener("statechange", activeListener);
    const add = vi.spyOn(activeFrame, "addEventListener");
    const remove = vi.spyOn(activeFrame, "removeEventListener");

    retire(retired);
    retired.change("suspended");
    retired.pending[0].resolve();
    await settle();
    activeFrame.notify();
    retired.change("closed");

    expect(activeFrame.state).toBe("running");
    expect(activeFrame.suspend).not.toHaveBeenCalled();
    expect(activeFrame.resume).not.toHaveBeenCalled();
    expect(activeFrame.close).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(activeListener).toHaveBeenCalledTimes(1);
  });
});
