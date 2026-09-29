import { WebSocketServer } from "ws";
import { hash } from "./security.mjs";

const watched = {
  agent_questions: ["agent_questions", "tasks"],
  agent_notifications: ["agent_notifications", "works"],
  connections_list: ["connections"],
  engines_list: ["engines"],
  works_tasks: ["tasks"],
  works_preview_status: ["works", "previews"],
  works_chat_turns: ["tasks"],
  works_background: ["tasks"],
  works_exports: ["tasks"],
  auth_state: ["auth_flows"],
  task_get: ["events", "tasks"],
  tools_info: ["settings"],
  works_sync_status: ["work_sync"],
};
export async function installRealtime(app, db, actions, origin) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let listener,
    reconnect,
    closed = false;
  const changed = (table) => {
    for (const ws of wss.clients) ws.refresh?.(table);
  };
  const listen = async () => {
    if (closed) return;
    try {
      listener = await db.pool.connect();
      listener.on("notification", ({ payload }) => changed(payload));
      listener.once("error", () => {
        listener.release(true);
        listener = undefined;
        for (const ws of wss.clients)
          ws.close(1013, "State stream reconnecting");
        if (!closed) reconnect = setTimeout(listen, 1000);
      });
      await listener.query("LISTEN frame_changes");
      changed(null);
    } catch {
      if (!closed) reconnect = setTimeout(listen, 2000);
    }
  };
  await listen();
  const authorized = async (session) =>
    !!session &&
    !!(await db.one(
      "SELECT hash FROM sessions WHERE hash=$1 AND expires>now()",
      [session],
    ));
  const upgrade = async (req, socket, head) => {
    if (req.url !== "/api/ws") {
      socket.destroy();
      return;
    }
    try {
      const session = app.parseCookie(req.headers.cookie || "").frame_session;
      if (
        req.headers.origin !== origin ||
        !(await authorized(session && hash(session)))
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.session = hash(session);
        wss.emit("connection", ws);
      });
    } catch {
      socket.destroy();
    }
  };
  app.server.on("upgrade", upgrade);
  wss.on("connection", (ws) => {
    const subscriptions = new Map();
    let alive = true,
      inFlight = 0,
      timer;
    const send = (value) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        ws.close(1013, "Slow consumer");
        return;
      }
      ws.send(JSON.stringify(value));
    };
    const refresh = async (sub) => {
      if (sub.busy) {
        sub.dirty = true;
        return;
      }
      sub.busy = true;
      try {
        do {
          sub.dirty = false;
          if (!(await authorized(ws.session))) {
            ws.close(4401, "Please sign in");
            return;
          }
          const result = await actions.call(sub.name, sub.args);
          const json = JSON.stringify(result);
          if (json !== sub.last && subscriptions.get(sub.id) === sub) {
            sub.last = json;
            send({ type: "update", id: sub.id, result });
          }
          if (sub.name === "task_get" && result.events.length) {
            sub.args = { ...sub.args, after: Number(result.events.at(-1).id) };
            if (result.events.length === 100) sub.dirty = true;
          }
        } while (
          sub.dirty &&
          ws.readyState === 1 &&
          subscriptions.get(sub.id) === sub
        );
      } catch (e) {
        send({
          type: "update",
          id: sub.id,
          error: e.statusCode === 500 ? "读取状态失败" : e.message,
          status: e.statusCode || 500,
        });
      } finally {
        sub.busy = false;
      }
    };
    const dirtyTables = new Set();
    ws.refresh = (table) => {
      dirtyTables.add(table);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const sub of subscriptions.values())
          if (
            dirtyTables.has(null) ||
            watched[sub.name].some((t) => dirtyTables.has(t))
          )
            void refresh(sub);
        dirtyTables.clear();
      }, 80);
    };
    ws.on("message", async (data) => {
      let message, counted = false;
      try {
        message = JSON.parse(data.toString());
        if (typeof message.id !== "string" || message.id.length > 80)
          throw Error("Invalid request id");
        counted = true;
        if (++inFlight > 32) throw Error("Too many requests");
        if (!(await authorized(ws.session))) {
          ws.close(4401, "Please sign in");
          return;
        }
        if (message.type === "unsubscribe") subscriptions.delete(message.id);
        else if (message.type === "subscribe") {
          if (!watched[message.name] || subscriptions.size >= 80)
            throw Error("Invalid subscription");
          const sub = { ...message, args: message.args || {} };
          subscriptions.set(message.id, sub);
          void refresh(sub);
        } else if (message.type === "call") {
          const result = await actions.call(message.name, message.args);
          send({ type: "result", id: message.id, result });
        } else throw Error("Unknown message");
      } catch (e) {
        send({
          type: message?.type === "subscribe" ? "update" : "result",
          id: message?.id,
          error:
            e.statusCode && e.statusCode < 500
              ? e.message
              : "操作未完成，请检查状态后重试",
          status: e.name === "ZodError" ? 400 : e.statusCode || 500,
        });
      } finally {
        if (counted) inFlight = Math.max(0, inFlight - 1);
      }
    });
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(async () => {
      try {
        if (!alive) {
          ws.terminate();
          return;
        }
        if (!(await authorized(ws.session))) {
          ws.close(4401, "Please sign in");
          return;
        }
        alive = false;
        ws.ping();
      } catch {
        ws.close(1013, "Reconnecting");
      }
    }, 25000);
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      subscriptions.clear();
    });
  });
  app.addHook("preClose", async () => {
    closed = true;
    clearTimeout(reconnect);
    app.server.off("upgrade", upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    if (listener) {
      await listener.query("UNLISTEN frame_changes").catch(() => {});
      listener.release();
      listener = undefined;
    }
  });
}
