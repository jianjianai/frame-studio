import test from "node:test";
import assert from "node:assert/strict";
import {
  embeddedAiUrl,
  nativeAiUrl,
  standaloneAiUrl,
  clearRetiredChatStorage,
} from "../../studio/ai-session.mjs";

const origin = "http://frame.local:3000";
const bootstrap = {
  workId: "work-a",
  projectId: "native-project",
  environmentId: "local-runtime",
  parentOrigin: origin,
  basePath: "/ai/",
  embedPath: "/ai/works/work-a/",
  nonce: "signed-work-session",
};
const session = {
  bootstrap,
  uiUrl: bootstrap.embedPath + "?frameNonce=" + bootstrap.nonce,
  standaloneUrl: "/ai/",
};

test("an embedded session binds the iframe to the selected work and shared runtime", () => {
  assert.equal(
    embeddedAiUrl(session, origin, "work-a"),
    origin + session.uiUrl,
  );
  for (const value of [
    { ...session, uiUrl: "/ai/works/work-b/?frameNonce=" + bootstrap.nonce },
    { ...session, uiUrl: session.uiUrl.replace(bootstrap.nonce, "other") },
    { ...session, bootstrap: { ...bootstrap, embedPath: "/ai/works/work-b/" } },
    {
      ...session,
      bootstrap: { ...bootstrap, parentOrigin: "https://foreign.example" },
    },
  ])
    assert.throws(() => embeddedAiUrl(value, origin, "work-a"), /连接范围无效/);
  assert.throws(() => embeddedAiUrl(session, origin, "work-b"), /连接范围无效/);
});

test("the full workbench retains the current native conversation without carrying embed credentials", () => {
  const url = new URL(
    standaloneAiUrl(session, "/ai/local-runtime/thread-a", origin),
  );
  assert.equal(url.pathname, "/ai/local-runtime/thread-a");
  assert.equal(url.searchParams.get("frameStandalone"), "1");
  assert.equal(url.searchParams.has("frameNonce"), false);
  assert.equal(
    new URL(standaloneAiUrl(session, "/ai/local-runtime/thread-b", origin))
      .pathname,
    "/ai/local-runtime/thread-b",
  );
  for (const value of [
    "https://foreign.example/ai/",
    "/api/me",
    "about:blank",
    session.uiUrl,
  ])
    assert.equal(
      new URL(standaloneAiUrl(session, value, origin)).pathname,
      "/ai/",
    );
});

test("native settings can be opened without any work bootstrap", () => {
  assert.equal(
    nativeAiUrl("/ai/settings/providers", origin).href,
    origin + "/ai/settings/providers",
  );
  assert.throws(() => nativeAiUrl("/api/settings", origin), /连接范围无效/);
});

test("retired browser drafts are removed while native conversation and work preferences remain", () => {
  const data = new Map([
    ["frame.agent-navigation", "old"],
    ["frame.chat-draft:old", "old"],
    ["t3.conversations", "native"],
    ["frame.assets:work-a", "assets"],
    ["frame.work-tool", "ai"],
  ]);
  clearRetiredChatStorage([
    {
      get length() {
        return data.size;
      },
      key: (index) => [...data.keys()][index],
      removeItem: (key) => data.delete(key),
    },
    {
      get length() {
        throw Error("disabled");
      },
    },
  ]);
  assert.deepEqual(
    [...data.keys()],
    ["t3.conversations", "frame.assets:work-a", "frame.work-tool"],
  );
});
