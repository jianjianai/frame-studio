import { WebSocketServer } from "ws";
import { hash } from "./security.mjs";
import { operationError } from "../src/contracts/errors.mjs";
import { decodeNotification, notificationMatches } from "../src/contracts/realtime-scope.mjs";

const watched = {
  connections_list: ["connections"],
  connections_usage: ["connections", "tasks", "auth_flows", "chats"],
  engines_list: ["engines"],
  works_tasks: ["tasks"],
  works_queue_status: ["tasks", "settings", "work_undos"],
  works_preview_status: ["works", "previews"],
  works_chat_turns: ["tasks"],
  works_background: ["tasks"],
  works_exports: ["tasks"],
  auth_state: ["auth_flows"],
  task_get: ["events", "tasks"],
  tools_info: ["settings"],
  works_sync_status: ["work_sync"],
  works_scm_status: ["works", "work_sync", "tasks", "work_undos"],
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
  const changed = (payload) => {
    const change = decodeNotification(payload);
    for (const ws of wss.clients) ws.refresh?.(change);
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
      if (sub.resolving) return;
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
          ...operationError(e, sub.id),
        });
      } finally {
        sub.busy = false;
      }
    };
    const changes = new Map();
    ws.refresh = (change) => {
      if (changes.size >= 1024) { changes.clear(); changes.set("all", null); }
      else if (!changes.has("all")) changes.set(change ? JSON.stringify(change) : "all", change);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const sub of subscriptions.values())
          if (
            [...changes.values()].some(change => notificationMatches(change, watched[sub.name], sub.scope))
          )
            void refresh(sub);
        changes.clear();
      }, 80);
    };
    ws.on("message", async (data) => {
      let message, pendingSubscription, counted = false;
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
          const args = actions.registry[message.name].schema.parse(message.args || {});
          const sub = { ...message, args, scope: {}, resolving: true };
          pendingSubscription = sub;
          subscriptions.set(message.id, sub);
          let scope = {};
          if (message.name === "task_get") scope = { task: args.id };
          else if (message.name.startsWith("works_") && args.id) {
            const work = await actions.works.get(args.id);
            scope = { work: work.id, repo: work.repo, project: work.project, ...(args.chat ? { chat: args.chat } : {}) };
          }
          if (subscriptions.get(message.id) !== sub || ws.readyState !== 1) return;
          Object.assign(sub, { scope, resolving: false });
          void refresh(sub);
        } else if (message.type === "call") {
          const result = await actions.call(message.name, message.args);
          send({ type: "result", id: message.id, result });
        } else throw Error("Unknown message");
      } catch (e) {
        if (pendingSubscription?.resolving && subscriptions.get(pendingSubscription.id) === pendingSubscription)
          subscriptions.delete(pendingSubscription.id);
        send({
          type: message?.type === "subscribe" ? "update" : "result",
          id: message?.id,
          ...operationError(e, message?.id),
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
