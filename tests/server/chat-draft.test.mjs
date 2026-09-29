import test from "node:test";
import assert from "node:assert/strict";
import { canClearDraft, canReuseSubmission } from "../../studio/chat-draft.js";
test("slow acknowledgements cannot clear edited, retyped or switched-conversation drafts", () => {
  const sent = { text: "first message", version: 1, conversation: 2 };
  assert(canClearDraft(sent, { ...sent }));
  assert(!canClearDraft(sent, { ...sent, text: "next message", version: 2 }));
  assert(!canClearDraft(sent, { ...sent, version: 3 }));
  assert(!canClearDraft(sent, { ...sent, conversation: 3 }));
  assert(!canClearDraft({ ...sent, text: "retried earlier message" }, sent));
});

test("retries preserve frozen intent until the user changes the draft, connection or material selection", () => {
  const value = { text: "adjust motion", version: 1, conversation: 2, work: "work", chat: "chat", connection: "connection", usePosition: true, assetIds: ["asset"] };
  assert(canReuseSubmission(value, { ...value }));
  assert(!canReuseSubmission(value, { ...value, version: 2 }));
  assert(!canReuseSubmission(value, { ...value, connection: "other" }));
  assert(!canReuseSubmission(value, { ...value, assetIds: ["new asset"] }));
  assert(!canReuseSubmission(value, { ...value, usePosition: false }));
});
