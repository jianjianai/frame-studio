import test from "node:test";
import assert from "node:assert/strict";
import { canClearDraft } from "../../studio/chat-draft.js";
test("slow acknowledgements cannot clear edited, retyped or switched-conversation drafts", () => {
  const sent = { text: "first message", version: 1, conversation: 2 };
  assert(canClearDraft(sent, { ...sent }));
  assert(!canClearDraft(sent, { ...sent, text: "next message", version: 2 }));
  assert(!canClearDraft(sent, { ...sent, version: 3 }));
  assert(!canClearDraft(sent, { ...sent, conversation: 3 }));
  assert(!canClearDraft({ ...sent, text: "retried earlier message" }, sent));
});
