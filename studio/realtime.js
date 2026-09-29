let socket,
  reconnect,
  attempts = 0;
const calls = new Map(),
  subscriptions = new Map();
const status = (state) =>
  window.dispatchEvent(new CustomEvent("frame-connection", { detail: state }));
function connect() {
  if (socket && socket.readyState < 2) return socket;
  clearTimeout(reconnect);
  const ws = (socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
  ));
  ws.onopen = () => {
    attempts = 0;
    status("connected");
    for (const sub of subscriptions.values())
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: sub.id,
          name: sub.name,
          args: sub.args,
        }),
      );
  };
  ws.onmessage = ({ data }) => {
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (value.type === "update") {
      const sub = subscriptions.get(value.id);
      if (sub?.name === "task_get" && value.result?.events?.length)
        sub.args = {
          ...sub.args,
          after: Number(value.result.events.at(-1).id),
        };
      sub?.receive(value);
    } else {
      // Compatibility with servers that used a result envelope for subscription rejection.
      const sub = subscriptions.get(value.id);
      if (sub && value.error) { sub.receive(value); return; }
      const call = calls.get(value.id);
      if (!call) return;
      calls.delete(value.id);
      clearTimeout(call.timer);
      value.error
        ? call.reject(
            Object.assign(new Error(value.error), { status: value.status }),
          )
        : call.resolve(value.result);
    }
  };
  ws.onclose = ({ code }) => {
    if (socket !== ws) return;
    socket = undefined;
    status("reconnecting");
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(
        new Error("连接中断；操作可能已提交，请查看最新状态后重试。"),
      );
    }
    calls.clear();
    if (code === 4401) {
      window.dispatchEvent(new Event("frame-auth-required"));
      return;
    }
    if (subscriptions.size)
      reconnect = setTimeout(
        connect,
        Math.min(15000, 500 * 2 ** attempts++) + Math.random() * 250,
      );
  };
  return ws;
}
export async function socketCall(name, args = {}) {
  const ws = connect();
  if (ws.readyState !== 1)
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", open);
        ws.removeEventListener("close", close);
      };
      const open = () => {
        cleanup();
        resolve();
      };
      const close = () => {
        cleanup();
        reject(new Error("连接失败，请刷新页面重试"));
      };
      const timer = setTimeout(close, 15000);
      ws.addEventListener("open", open, { once: true });
      ws.addEventListener("close", close, { once: true });
    });
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new Error("等待响应超时，请查看操作状态"));
    }, 300000);
    calls.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "call", id, name, args }));
  });
}
export function subscribe(name, args, receive) {
  const id = crypto.randomUUID();
  subscriptions.set(id, { id, name, args, receive });
  const ws = connect();
  if (ws.readyState === 1)
    ws.send(JSON.stringify({ type: "subscribe", id, name, args }));
  return () => {
    subscriptions.delete(id);
    if (socket?.readyState === 1)
      socket.send(JSON.stringify({ type: "unsubscribe", id }));
  };
}
