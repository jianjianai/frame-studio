import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewSessionController } from "../../studio/live-preview-session.mjs";

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness(
  loadLive,
  loadStable = async (latest) => ({ url: "/published/" + latest.id }),
) {
  const timers = new Map(),
    states = [];
  let sequence = 0,
    clock = 100000;
  const owner = createPreviewSessionController({
    loadLive,
    loadStable,
    publish: (value) => states.push(value),
    now: () => clock,
    schedule: (fn, delay) => {
      const id = ++sequence;
      timers.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  return {
    owner,
    timers,
    states,
    fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      clock += timer.delay;
      timer.fn();
    },
  };
}
const link = (id, state = "ready") => ({
  url: "/live/" + id,
  sessionId: id,
  source: "work",
  sourceRevision: "a".repeat(64),
  state,
  expires: new Date(100000 + 3600000).toISOString(),
});
const input = { workId: "work-a", mode: "live", blocked: false };

test("live attachment does not depend on a published build and updates preserve iframe identity and displayed revision", async () => {
  const calls = [],
    h = harness(async (value) => {
      calls.push(value);
      return link("session-a");
    });
  h.owner.update(input);
  await settle();
  assert.deepEqual(calls, [{ id: "work-a" }]);
  const url = h.owner.getState().preview.url;
  h.owner.receive({ state: "ready", sourceRevision: "b".repeat(64) });
  h.owner.receive({ state: "updating", sourceRevision: "c".repeat(64) });
  assert.equal(
    h.owner.getState().preview.sourceRevision,
    "b".repeat(64),
    "an unfinished revision is not an observed reference",
  );
  h.owner.receive({
    state: "error",
    error: "syntax error",
    sourceRevision: "c".repeat(64),
  });
  assert.equal(h.owner.getState().preview.url, url);
  assert.equal(h.owner.getState().preview.sourceRevision, "b".repeat(64));
  h.owner.receive({ state: "ready", sourceRevision: "d".repeat(64) });
  assert.equal(h.owner.getState().error, "");
  assert.equal(h.owner.getState().stage, "");
  assert.equal(h.owner.getState().preview.url, url);
  h.owner.dispose();
  assert.equal(h.timers.size, 0);
});

test("late source and retry responses cannot overwrite a newer work, including after disposal", async () => {
  const first = deferred(),
    second = deferred(),
    final = deferred();
  const h = harness(({ id }) =>
    id === "work-a" ? first.promise : second.promise,
  );
  h.owner.update(input);
  h.owner.update({ ...input, workId: "work-b" });
  second.resolve(link("session-b"));
  await settle();
  first.resolve(link("old-session"));
  await settle();
  assert.equal(h.owner.getState().preview.id, "session-b");
  const race = harness(() => final.promise);
  race.owner.update(input);
  race.owner.dispose();
  final.resolve(link("disposed"));
  await settle();
  assert.equal(
    race.states.some((state) => state.preview),
    false,
  );
  h.owner.dispose();
});

test("background tasks and native agents never select another preview source; local export blocking preserves the work session", async () => {
  const calls = [];
  const h = harness(async (args) => {
    calls.push(args);
    return link("work");
  });
  h.owner.update(input);
  await settle();
  h.owner.update({ ...input, blocked: true });
  h.owner.update({ ...input, blocked: false });
  await settle();
  assert.equal(
    calls.length,
    1,
    "ending an export does not renew or remount an unchanged work session",
  );
  h.owner.update({
    ...input,
    taskId: "task-a",
    source: "alternate",
    aiThread: "agent-a",
  });
  await settle();
  assert.equal(
    calls.length,
    1,
    "retired source selectors cannot create another attachment",
  );
  h.owner.retry();
  await settle();
  assert.deepEqual(calls, [{ id: "work-a" }, { id: "work-a" }]);
  assert.equal(h.owner.getState().preview.id, "work");
  h.owner.dispose();
});

test("disconnection retains a working player; first failure falls back explicitly and retries with bounded delay", async () => {
  let online = false,
    stable = 0;
  const h = harness(
    async () => {
      if (!online) throw Error("network unavailable");
      return link("recovered");
    },
    async (latest) => {
      stable++;
      return { url: "/published/" + latest.id };
    },
  );
  h.owner.update({
    ...input,
    latest: { id: "built", source_commit: "a".repeat(40) },
  });
  await settle();
  assert.equal(h.owner.getState().preview.fallback, true);
  assert.equal(h.owner.getState().status, "reconnecting");
  assert.equal(stable, 1);
  assert.equal([...h.timers.values()][0].delay, 2000);
  online = true;
  h.fire();
  await settle();
  assert.equal(h.owner.getState().preview.live, true);
  online = false;
  h.owner.retry();
  await settle();
  assert.equal(
    h.owner.getState().preview.id,
    "recovered",
    "network failure retains live audio and last good frame",
  );
  assert.equal(
    stable,
    1,
    "a running live player is never replaced by stale publication on transient disconnect",
  );
  h.owner.dispose();
});

test("immutable review renews the same historical build", async () => {
  const stableCalls = [];
  const h = harness(
    async () => {
      throw Error("live transport must not be used");
    },
    async (value) => {
      stableCalls.push(value.id);
      return {
        url: "/published/" + value.id,
        expires: new Date(3700000).toISOString(),
      };
    },
  );
  const stable = {
    workId: "work-a",
    mode: "immutable",
    latest: { id: "build-a", source_commit: "a".repeat(40) },
    blocked: false,
  };
  h.owner.update(stable);
  await settle();
  h.owner.update({ ...stable, blocked: true });
  h.owner.update(stable);
  await settle();
  assert.deepEqual(stableCalls, ["build-a"]);
  h.fire();
  await settle();
  assert.deepEqual(stableCalls, ["build-a", "build-a"]);
  h.owner.dispose();
});

test("manual reconnect generations discard a late reply for the same source and do not refetch the published fallback", async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const h = harness(() => (++calls === 1 ? first.promise : second.promise));
  h.owner.update(input);
  h.owner.retry();
  second.resolve(link("newer-session"));
  await settle();
  h.owner.receive({ state: "ready", sourceRevision: "e".repeat(64) });
  first.resolve(link("late-session"));
  await settle();
  assert.equal(h.owner.getState().preview.id, "newer-session");
  assert.equal(h.owner.getState().preview.observedRevision, "e".repeat(64));
  h.owner.dispose();
  let stable = 0;
  const fallback = harness(
    async () => {
      throw Error("offline");
    },
    async () => {
      stable++;
      return { url: "/published/same" };
    },
  );
  fallback.owner.update({ ...input, latest: { id: "same" } });
  await settle();
  fallback.fire();
  await settle();
  assert.equal(
    stable,
    1,
    "a repeated live failure reuses the existing immutable capability",
  );
  fallback.owner.dispose();
});

test("lost runtime event streams reattach with bounded backoff and retain the observed revision", async () => {
  let online = true;
  const h = harness(async () => {
    if (!online) throw Error("connection lost");
    return link("same-session");
  });
  h.owner.update(input);
  await settle();
  h.owner.receive({ state: "ready", sourceRevision: "f".repeat(64) });
  online = false;
  h.owner.receive({ state: "reconnecting" });
  assert.equal([...h.timers.values()][0].delay, 2000);
  h.fire();
  await settle();
  assert.equal([...h.timers.values()][0].delay, 4000);
  assert.equal(h.owner.getState().preview.id, "same-session");
  online = true;
  h.fire();
  await settle();
  assert.equal(
    h.owner.getState().preview.observedRevision,
    "f".repeat(64),
    "renewal metadata cannot cite a source the player has not applied",
  );
  assert.equal(h.owner.getState().error, "");
  h.owner.dispose();
  assert.equal(h.timers.size, 0);
});
