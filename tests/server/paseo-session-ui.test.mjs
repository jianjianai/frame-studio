import test from "node:test";
import assert from "node:assert/strict";
import {
  standalonePaseoUrl,
  clearRetiredChatStorage,
} from "../../studio/paseo-session.mjs";

const origin = "http://127.0.0.1:3000";
const bootstrap = {
  workId: "work-a",
  parentOrigin: origin,
  basePath: "/paseo/work-a/",
  nonce: "signed-work-session",
};
const session = {
  bootstrap,
  uiUrl: "/paseo/work-a/?frameNonce=signed-work-session",
};

test("a separate Paseo tab preserves the native conversation route and authenticated work scope", () => {
  const route =
    origin +
    "/paseo/work-a/h/server/workspace/main?open=agent%3Acurrent&frameNonce=signed-work-session";
  const url = new URL(
    standalonePaseoUrl(session, route, origin + "/#/work/work-a"),
  );
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/paseo/work-a/h/server/workspace/main");
  assert.equal(url.searchParams.get("open"), "agent:current");
  assert.equal(url.searchParams.get("frameNonce"), bootstrap.nonce);
  assert.equal(url.searchParams.get("frameStandalone"), "1");
});

test("a changed or inaccessible frame route cannot navigate a Paseo tab outside this work", () => {
  for (const current of [
    "https://foreign.example/paseo/work-a/",
    "/paseo/work-b/?frameNonce=other",
    "/paseo/work-a/../../api/me",
    "about:blank",
  ])
    assert.equal(
      new URL(standalonePaseoUrl(session, current, origin)).pathname,
      bootstrap.basePath,
    );
  assert.throws(
    () =>
      standalonePaseoUrl(
        { ...session, uiUrl: "/paseo/work-b/?frameNonce=signed-work-session" },
        null,
        origin,
      ),
    /连接范围无效/,
  );
  assert.throws(
    () =>
      standalonePaseoUrl(
        {
          ...session,
          bootstrap: { ...bootstrap, parentOrigin: "https://foreign.example" },
        },
        null,
        origin,
      ),
    /连接范围无效/,
  );
  assert.throws(
    () =>
      standalonePaseoUrl(
        { ...session, uiUrl: "/paseo/work-a/?frameNonce=wrong" },
        null,
        origin,
      ),
    /连接范围无效/,
  );
});

test("a consumed native route reopens the active conversation, while an explicit route intent takes precedence", () => {
  const route = origin + "/paseo/work-a/h/server/workspace/main";
  assert.equal(
    new URL(
      standalonePaseoUrl(session, route, origin, "current"),
    ).searchParams.get("open"),
    "agent:current",
  );
  assert.equal(
    new URL(
      standalonePaseoUrl(session, route + "?open=agent:new", origin, "current"),
    ).searchParams.get("open"),
    "agent:new",
  );
});

test("retired browser chat data is removed while native Paseo messages and current work preferences remain", () => {
  const data = new Map([
    ["frame.agent-navigation", "old-turn"],
    ["frame.agent-answer:old-question", "old-answer"],
    ["frame.agent-notifications.v1", "old-settings"],
    ["frame.chat-draft:old-conversation", "old-draft"],
    ["paseo.messages:current", "native-conversation"],
    ["frame.assets:work-a", "selected-assets"],
    ["frame.work-tool", "ai"],
  ]);
  const storage = {
    get length() {
      return data.size;
    },
    key(index) {
      return [...data.keys()][index];
    },
    removeItem(key) {
      data.delete(key);
    },
  };
  clearRetiredChatStorage([
    storage,
    {
      get length() {
        throw Error("Storage disabled");
      },
    },
  ]);
  assert.deepEqual(
    [...data.keys()],
    ["paseo.messages:current", "frame.assets:work-a", "frame.work-tool"],
  );
});
