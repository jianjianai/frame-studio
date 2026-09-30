import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLivePreviewWorker } from "../../server/live-preview-worker.mjs";
import { createLivePreviewBundleSender } from "../../scripts/live-preview-worker.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function harness(onBundle, onError = () => {}) {
  const child = new EventEmitter(), sent = [], errors = [];
  child.connected = true; child.exitCode = null; child.signalCode = null;
  child.send = (message, callback) => {
    sent.push(message); callback?.();
    if (message.type === "stop") {
      child.connected = false; child.exitCode = 0; child.emit("exit", 0, null);
    }
  };
  child.kill = () => { child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL"); };
  const worker = createLivePreviewWorker({ root: ".", onBundle, onError: error => { errors.push(error); onError(error); } }, { forkWorker: () => child });
  return { child, worker, sent, errors };
}

test("bundle IPC accepts warm builds immediately and sends only the first and newest revisions until ACK", async () => {
  const sent = [], errors = [];
  const sender = createLivePreviewBundleSender({
    send: (message, callback) => { sent.push(message); callback(); },
    onError: error => errors.push(error),
  });
  for (let revision = 1; revision <= 1000; revision++)
    assert.equal(sender.push({ sourceRevision: revision }), undefined);
  assert.deepEqual(sent.map(message => message.value.sourceRevision), [1]);
  sender.acknowledge(999);
  assert.equal(sent.length, 1, "a stale ACK cannot release the in-flight payload");
  sender.acknowledge(sent[0].id);
  assert.deepEqual(sent.map(message => message.value.sourceRevision), [1, 1000]);
  sender.acknowledge(sent[0].id);
  assert.equal(sent.length, 2, "a duplicate ACK cannot release a newer payload");
  sender.close();
  sender.acknowledge(sent[1].id); sender.push({ sourceRevision: 1001 });
  assert.equal(sent.length, 2);
  assert.deepEqual(errors, []);
});

test("parent ACK waits for publication and releases the newest pending bundle after a failure", async () => {
  const first = deferred(), newest = deferred(), published = [];
  const h = harness(value => {
    published.push(value.sourceRevision);
    return value.sourceRevision === 1 ? first.promise : newest.promise;
  });
  for (let revision = 1; revision <= 100; revision++)
    h.child.emit("message", { type: "bundle", id: revision, value: { sourceRevision: revision } });
  await settle();
  assert.deepEqual(published, [1]);
  assert.ok(!h.sent.some(message => message.type === "publish-ack" && message.id === 1));
  first.reject(Error("publication failed"));
  await settle();
  assert.deepEqual(published, [1, 100]);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /publication failed/);
  assert.ok(h.sent.some(message => message.type === "publish-ack" && message.id === 1));
  assert.ok(!h.sent.some(message => message.type === "publish-ack" && message.id === 100));
  newest.resolve();
  await settle();
  assert.ok(h.sent.some(message => message.type === "publish-ack" && message.id === 100));
  await h.worker.close();
  assert.equal(h.errors.length, 1);
});

test("close drops queued revisions and waits for current publication without sending a late ACK", async () => {
  const first = deferred(), published = [];
  const h = harness(value => { published.push(value); return first.promise; });
  h.child.emit("message", { type: "bundle", id: 1, value: "first" });
  h.child.emit("message", { type: "bundle", id: 2, value: "pending" });
  await settle();
  let closed = false;
  const closing = h.worker.close().then(() => { closed = true; });
  assert.equal(h.worker.close(), h.worker.close(), "close callers share the same cleanup");
  await settle();
  assert.equal(closed, false);
  first.resolve();
  await closing;
  assert.deepEqual(published, ["first"]);
  assert.deepEqual(h.sent.filter(message => message.type === "publish-ack"), []);
  assert.deepEqual(h.errors, []);
});

test("IPC send failures clear the child pending payload and report a terminal failure once", async () => {
  let complete;
  const sent = [], errors = [];
  const sender = createLivePreviewBundleSender({
    send: (message, callback) => { sent.push(message); complete = callback; },
    onError: error => errors.push(error),
  });
  sender.push("first"); sender.push("newest");
  complete(Error("IPC closed"));
  sender.acknowledge(sent[0].id); sender.push("later");
  assert.equal(sent.length, 1);
  assert.equal(errors.length, 1);

  const h = harness(() => {});
  h.child.emit("error", Error("worker disconnected"));
  h.child.emit("exit", 1, null);
  h.child.emit("message", { type: "bundle", id: 1, value: "ignored" });
  await settle();
  assert.equal(h.errors.length, 1);
  await h.worker.close();
});

test("action ACKs keep a newer compile error after an older slow publish and let a later valid bundle supersede a pending error", async () => {
  const first = deferred(), second = deferred(), events = [];
  const h = harness(async value => {
    events.push("start:" + value);
    if (value === "first") await first.promise;
    if (value === "second") await second.promise;
    events.push("ready:" + value);
  }, error => events.push("error:" + error.message));
  const sender = createLivePreviewBundleSender({
    send: (message, callback) => { h.child.emit("message", message); callback(); },
    onError: assert.fail,
  });
  const send = h.child.send;
  h.child.send = (message, callback) => {
    send(message, callback);
    if (message.type === "publish-ack") sender.acknowledge(message.id);
  };

  sender.push("first");
  await settle();
  sender.pushError({ message: "newer compile failure" });
  await settle();
  assert.deepEqual(events, ["start:first"], "compile failure waits until the older publish completes");
  first.resolve();
  await settle();
  assert.deepEqual(events, ["start:first", "ready:first", "error:newer compile failure"]);

  sender.push("second");
  await settle();
  sender.pushError({ message: "superseded compile failure" });
  sender.push("newest valid");
  second.resolve();
  await settle();
  assert.deepEqual(events.slice(3), ["start:second", "ready:second", "start:newest valid", "ready:newest valid"]);
  assert.equal(h.errors.length, 1, "the newest valid revision supersedes the unsent older failure");
  sender.close();
  await h.worker.close();
});
