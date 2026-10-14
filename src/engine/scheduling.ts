let channel: MessageChannel | undefined;
const waiting: (() => void)[] = [];

/**
 * Resolves on the next task of the event loop without a timer. A page in a background tab
 * has its timers held back (to once a second, later once a minute) but not its messages,
 * so long offline work (exports, offline audio) keeps its pace while the tab is hidden.
 */
export function nextTask(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()?.();
  }
  return new Promise((resolve) => {
    waiting.push(resolve);
    channel!.port2.postMessage(null);
  });
}
