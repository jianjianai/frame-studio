import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { installLivePreview } from "../../server/live-preview-routes.mjs";
import { LivePreviewSessions } from "../../server/live-preview.mjs";

const bounded = async (operation, timeout = 2000) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Live preview close did not finish within " + timeout + "ms",
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const until = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000)
      throw new Error("Live preview resources were not released");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function fixture(t, { heartbeat = false } = {}) {
  const app = Fastify(),
    sockets = new Set(),
    intervals = new Map(),
    responses = [];
  const session = {
    work: "fixture-work",
    closed: false,
    clients: 0,
    releases: new Set(),
    emitter: new EventEmitter(),
    manifest: {
      revision: 1,
      sourceRevision: "a".repeat(64),
      changes: { visual: true, audio: true, metadata: true },
    },
  };
  let attaches = 0,
    afterEndWrites = 0;
  const manager = {
    getByCapability(token) {
      assert.equal(token, "fixture-token");
      return session;
    },
    attach(value, close) {
      attaches++;
      return LivePreviewSessions.prototype.attach.call(this, value, close);
    },
    db: { one: async () => ({ deleted: false }) },
  };
  if (heartbeat) {
    const set = globalThis.setInterval,
      clear = globalThis.clearInterval;
    t.mock.method(globalThis, "setInterval", (callback, delay, ...args) => {
      if (delay !== 15000) return set(callback, delay, ...args);
      const token = { unref() {} };
      intervals.set(token, callback);
      return token;
    });
    t.mock.method(globalThis, "clearInterval", (token) => {
      if (intervals.has(token)) intervals.delete(token);
      else clear(token);
    });
  }
  app.addHook("onRequest", async (_req, reply) => {
    responses.push(reply.raw);
    const write = reply.raw.write;
    reply.raw.write = function (...args) {
      if (this.writableEnded) afterEndWrites++;
      return write.apply(this, args);
    };
  });
  installLivePreview(app, manager);
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    // Emergency test cleanup is local to this fixture; the assertions close with clients still open.
    for (const socket of sockets) socket.destroy();
    await app.close();
  });
  return {
    app,
    manager,
    session,
    intervals,
    responses,
    get attaches() {
      return attaches;
    },
    get afterEndWrites() {
      return afterEndWrites;
    },
    async listen() {
      await app.listen({ host: "127.0.0.1", port: 0 });
      return "http://127.0.0.1:" + app.server.address().port;
    },
  };
}

async function open(url) {
  const response = await new Promise((resolve, reject) => {
    const request = http.get(
      url + "/preview-live/fixture-token/events",
      { agent: false },
      resolve,
    );
    request.once("error", reject);
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  let text = "";
  response.setEncoding("utf8");
  response.on("data", (data) => {
    text += data;
  });
  const ended = new Promise((resolve) => response.once("end", resolve));
  await until(() => text.includes("event: revision"));
  return {
    response,
    ended,
    get text() {
      return text;
    },
  };
}
function assertReleased(f) {
  assert.equal(f.session.clients, 0);
  assert.equal(f.session.releases.size, 0);
  for (const name of ["revision", "error-state", "state"])
    assert.equal(f.session.emitter.listenerCount(name), 0);
  assert.equal(f.intervals.size, 0);
}

test("Fastify closes with multiple live SSE clients open, before manager onClose, and disposes pending heartbeats", async (t) => {
  const f = await fixture(t, { heartbeat: true });
  let managerClosed = false;
  f.app.addHook("onClose", async () => {
    assertReleased(f);
    managerClosed = true;
  });
  const url = await f.listen(),
    clients = await Promise.all([open(url), open(url)]);
  assert.equal(f.session.clients, 2);
  assert.equal(f.session.releases.size, 2);
  assert.equal(f.intervals.size, 2);
  assert.equal(f.session.emitter.listenerCount("revision"), 2);
  f.session.emitter.emit("state", { state: "ready" });
  await until(() =>
    clients.every((client) => client.text.includes("event: state")),
  );
  let finishQuery;
  f.manager.db.one = () =>
    new Promise((resolve) => {
      finishQuery = resolve;
    });
  const heartbeat = [...f.intervals.values()][0];
  const pending = heartbeat();
  assert.equal(typeof finishQuery, "function");
  await heartbeat(); // A pending query does not create overlapping work.
  await bounded(f.app.close());
  await bounded(Promise.all(clients.map((client) => client.ended)));
  assert.equal(managerClosed, true);
  assertReleased(f);
  assert.equal(
    f.responses.every((response) => response.writableEnded),
    true,
  );
  finishQuery({ deleted: false });
  await pending;
  assert.equal(
    f.afterEndWrites,
    0,
    "A heartbeat completing after preClose must not write to an ended stream",
  );
});

test("Client disconnect releases only its own listeners, attachment and heartbeat", async (t) => {
  const f = await fixture(t, { heartbeat: true }),
    url = await f.listen();
  const first = await open(url),
    second = await open(url);
  first.response.destroy();
  await until(() => f.session.clients === 1);
  assert.equal(f.session.releases.size, 1);
  assert.equal(f.intervals.size, 1);
  assert.equal(f.session.emitter.listenerCount("revision"), 1);
  f.session.emitter.emit("state", { state: "still-ready" });
  await until(() => second.text.includes("still-ready"));
  await bounded(f.app.close());
  await bounded(second.ended);
  assertReleased(f);
});

test("An app entering preClose rejects new SSE viewers without attaching them", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.app.addHook("preClose", async () => {
    entered();
    await blocked;
  });
  const url = await f.listen(),
    client = await open(url);
  const closing = f.app.close();
  try {
    await bounded(enteredPromise);
    await bounded(client.ended);
    assertReleased(f);
    const denied = await bounded(
      new Promise((resolve, reject) => {
        const request = http.get(
          url + "/preview-live/fixture-token/events",
          { agent: false },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
      }),
    );
    assert.equal(denied, 503);
    assert.equal(f.attaches, 1);
  } finally {
    release();
    await bounded(closing);
  }
});
