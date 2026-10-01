const key = "frame.agent-navigation";
const uuid = /^[a-f0-9-]{36}$/i;
export function readAgentTarget() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    return value &&
      uuid.test(value.work) &&
      uuid.test(value.task) &&
      (!value.chat || uuid.test(value.chat))
      ? value
      : null;
  } catch {
    return null;
  }
}
export function navigateToAgent(notification) {
  const target = {
    work: notification.work,
    chat: notification.chat,
    task: notification.task,
    question: notification.question || null,
    nonce: crypto.randomUUID(),
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(target));
  } catch {}
  window.location.hash = "/work/" + target.work;
  window.dispatchEvent(
    new CustomEvent("frame-agent-navigate", { detail: target }),
  );
}
