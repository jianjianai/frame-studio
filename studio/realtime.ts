import { operationContract, parseOperationResult, wireResponseSchema, taskGetResponseSchema } from "../src/contracts/platform.mjs";
import type { OperationName, OperationInput, OperationResult } from "../src/contracts/platform";

type Args = Record<string, unknown>;
export interface SubscriptionUpdate { result?: unknown; error?: string; status?: number }
interface Subscription { id: string; name: string; args: Args; receive: (value: SubscriptionUpdate) => void }
interface PendingCall { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
let socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined, attempts = 0;
const calls = new Map<string, PendingCall>(), subscriptions = new Map<string, Subscription>();
const status = (state: string) => window.dispatchEvent(new CustomEvent("frame-connection", { detail: state }));
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function connect(): WebSocket {
  if (socket && socket.readyState < 2) return socket;
  clearTimeout(reconnect);
  const ws = socket = new WebSocket(location.protocol.replace("http", "ws") + "//" + location.host + "/api/ws");
  ws.onopen = () => {
    attempts = 0;
    status("connected");
    for (const sub of subscriptions.values())
      ws.send(JSON.stringify({ type: "subscribe", id: sub.id, name: sub.name, args: sub.args }));
  };
  ws.onmessage = ({ data }) => {
    const parsed = (() => { try { return wireResponseSchema.safeParse(JSON.parse(String(data))); } catch { return null; } })();
    if (!parsed?.success) return;
    const value = parsed.data;
    const sub = subscriptions.get(value.id);
    if (value.type === "update" || (sub && value.error)) {
      if (!sub) return;
      if (value.error) { sub.receive(value); return; }
      try {
        const result = parseOperationResult(sub.name, value.result);
        sub.receive({ result });
        if (sub.name === "task_get") {
          const events = taskGetResponseSchema.parse(result).events;
          if (events.length) sub.args = { ...sub.args, after: Number(events.at(-1)!.id) };
        }
      } catch (error) { sub.receive({ error: "状态响应无效：" + messageOf(error) }); }
      return;
    }
    const call = calls.get(value.id);
    if (!call) return;
    calls.delete(value.id);
    clearTimeout(call.timer);
    if (value.error) call.reject(Object.assign(new Error(value.error), { status: value.status }));
    else {
      try { call.resolve(parseOperationResult(call.name, value.result)); }
      catch (error) { call.reject(new Error("操作响应无效，请先检查最新状态：" + messageOf(error))); }
    }
  };
  ws.onclose = ({ code }) => {
    if (socket !== ws) return;
    socket = undefined;
    status("reconnecting");
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("连接中断；操作可能已提交，请查看最新状态后重试。"));
    }
    calls.clear();
    if (code === 4401) { window.dispatchEvent(new Event("frame-auth-required")); return; }
    if (subscriptions.size) reconnect = setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++) + Math.random() * 250);
  };
  return ws;
}

export function socketCall<N extends OperationName>(name: N, args: OperationInput<N>): Promise<OperationResult<N>>;
export function socketCall(name: string, args?: Args): Promise<unknown>;
export async function socketCall(name: string, args: Args = {}): Promise<unknown> {
  const input = operationContract(name)?.request.parse(args) ?? args;
  const ws = connect();
  if (ws.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener("open", open); ws.removeEventListener("close", close); };
    const open = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error("连接失败，请刷新页面重试")); };
    const timer = setTimeout(close, 15000);
    ws.addEventListener("open", open, { once: true });
    ws.addEventListener("close", close, { once: true });
  });
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { calls.delete(id); reject(new Error("等待响应超时，请查看操作状态")); }, 300000);
    calls.set(id, { name, resolve, reject, timer });
    try { ws.send(JSON.stringify({ type: "call", id, name, args: input })); }
    catch (error) { calls.delete(id); clearTimeout(timer); reject(error); }
  });
}
export function subscribe(name: string, args: Args, receive: (value: SubscriptionUpdate) => void): () => void {
  const input = operationContract(name)?.request.parse(args) ?? args;
  const id = crypto.randomUUID();
  subscriptions.set(id, { id, name, args: input, receive });
  const ws = connect();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe", id, name, args: input }));
  return () => {
    subscriptions.delete(id);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", id }));
  };
}
