type RemotionAudioContext = Pick<
  AudioContext,
  "state" | "suspend" | "addEventListener" | "removeEventListener"
>;

/** Keep this retired Player's native context silent if an older resume finishes later. */
export function retireRemotionAudio(context: RemotionAudioContext): void {
  if (context.state === "closed") return;

  let stopped = false;
  let inFlight = false;
  const release = () => {
    if (stopped) return;
    stopped = true;
    context.removeEventListener("statechange", suspendIfRunning);
  };
  const suspensionFailed = () => {
    inFlight = false;
    // Retry only for a later statechange, never in a rejected-promise loop.
    if (context.state === "closed") release();
  };
  const suspendIfRunning = () => {
    if (stopped) return;
    if (context.state === "closed") {
      release();
      return;
    }
    if (inFlight || context.state !== "running") return;
    inFlight = true;
    let suspension: Promise<void>;
    try {
      suspension = context.suspend();
    } catch {
      suspensionFailed();
      return;
    }
    void suspension.then(() => {
      inFlight = false;
      // A previously requested resume can win after this suspend has resolved.
      suspendIfRunning();
    }, suspensionFailed);
  };

  context.addEventListener("statechange", suspendIfRunning);
  suspendIfRunning();
}
