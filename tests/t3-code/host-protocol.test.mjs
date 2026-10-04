import test from "node:test";
import assert from "node:assert/strict";
import { frameAttachedReview, frameReviewUrl, readFrameReviewUrl, FrameFreezeInputSchema } from "../../integrations/t3-code/shared/bridge.mjs";
const workId = "7987f1c7-3913-44bd-807f-02295b0c8b9e", threadId = "thread-a";
const assetId = "0c4d4e3f-c157-416a-a10b-af7b9e04bb42";
const context = { time: 12, liveSessionId: "e94b62b8-b979-4a55-a597-29b575865d49", sourceRevision: "a".repeat(64), compiledRevision: "b".repeat(64), assets: [assetId] };
const item = reference => ({ id: "reference-a", title: "Recorded frame", text: "Recorded frame", resourceType: "frame-reference", url: frameReviewUrl(workId, reference, "http://frame.example/") });
test("explicit chips carry frozen preview versions and materials; deleting every chip sends no reference", () => {
  assert.deepEqual(frameAttachedReview([item(context)], workId), context);
  assert.equal(frameAttachedReview([], workId), undefined);
  assert.deepEqual(FrameFreezeInputSchema.parse({ threadId, messageId: "eac6c5d2-81d0-4572-a2f8-52d134638ece", text: "Edit this", nativeProjectId: workId, cwd: "/work", selection: { instanceId: "codex", model: "gpt" }, reference: frameAttachedReview([item(context)], workId) }).reference, context);
  assert.deepEqual(readFrameReviewUrl(item(context).url, workId), context);
});
test("same-source timecodes retain the latest primary image and deduplicate selected materials", () => {
  const { time: _time, ...later } = context;
  assert.deepEqual(frameAttachedReview([item(context), item({ ...later, start: 20, end: 22 })], workId), { ...later, start: 20, end: 22 });
});
test("different rendered sources cannot be silently frozen against the current player", () => {
  assert.throws(() => frameAttachedReview([item(context), item({ ...context, sourceRevision: "c".repeat(64) })], workId), /different preview versions/);
  assert.equal(readFrameReviewUrl(item(context).url, "959f9b57-dcf7-44aa-a16d-8cfd5706dc3f"), null);
});
