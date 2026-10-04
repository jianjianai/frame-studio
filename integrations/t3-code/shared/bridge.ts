/** FRAME's host protocol is independent of the native UI's dependencies. */
export type FrameReviewContext = {
  time?: number; start?: number; end?: number; shotId?: string; assets?: string[];
  previewTask?: string; sourceCommit?: string; liveSessionId?: string;
  sourceRevision?: string; compiledRevision?: string;
};
export type FrameBootstrap = {
  version: 1; workId: string; projectId: string; environmentId: string; cwd: string;
  label: string; userScope: string; parentOrigin: string; nonce: string;
  basePath: string; embedPath: string;
};
export type FrameFreezeInput = {
  threadId: string; messageId: string; text: string; nativeProjectId: string; cwd: string;
  selection: { instanceId: string; model: string };
  reference?: FrameReviewContext; screenshots?: unknown[];
};
export type FrameContextAttachment = {
  id: string; identifier?: string; title: string; subtitle?: string;
  url: string; text: string; resourceType: string;
};
export type FrameFreezeResponse = {
  version: 1; workId: string; threadId: string; messageId: string; intentHash: string;
  context: FrameReviewContext; reviewReference: Record<string, unknown>;
  attachment?: { type: "text"; mimeType: "text/plain"; title?: string | null; text: string };
};
export const frameOperations = ["context.read", "context.subscribe", "context.attach", "freeze.submit",
  "message.accepted", "preview.open", "results.open", "dock.close"] as const;
export type FrameOperation = typeof frameOperations[number];
export type FramePortRequest = { type: "request"; id: string; op: FrameOperation; payload: unknown };

type Check = (value: unknown) => void;
const fail = (message: string): never => { throw new TypeError(message); };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : fail("Expected an object");
const text = (max = 256, min = 1): Check => value => {
  if (typeof value !== "string" || value.length < min || value.length > max) fail("Invalid string");
};
const matching = (pattern: RegExp): Check => value => {
  text()(value); if (!pattern.test(value as string)) fail("Invalid identifier");
};
const uuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const sha = matching(/^[a-f0-9]{64}$/);
const choice = (values: readonly unknown[]): Check => value => {
  if (!values.includes(value)) fail("Invalid protocol value");
};
const array = (check: Check, max: number): Check => value => {
  if (!Array.isArray(value) || value.length > max) fail("Invalid array");
  (value as unknown[]).forEach(check);
};
const finiteTime: Check = value => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3600) fail("Invalid time");
};
const url: Check = value => { text(8192)(value); new URL(value as string); };
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value => {
  const item = record(value);
  for (const key of Object.keys(item)) if (!(key in required) && !(key in optional)) fail("Unexpected field: " + key);
  for (const [key, check] of Object.entries(required)) check(item[key]);
  for (const [key, check] of Object.entries(optional)) if (item[key] !== undefined) check(item[key]);
};
const schema = <T>(check: Check) => ({
  parse(value: unknown): T { check(value); return value as T; },
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } {
    try { check(value); return { success: true, data: value as T }; }
    catch (error) { return { success: false, error }; }
  },
});
const review: Check = value => {
  object({}, { time: finiteTime, start: finiteTime, end: finiteTime,
    shotId: matching(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/), assets: array(uuid, 20),
    previewTask: uuid, sourceCommit: matching(/^[a-f0-9]{40}$/), liveSessionId: uuid,
    sourceRevision: sha, compiledRevision: sha })(value);
  const item = record(value);
  if ((item.start === undefined) !== (item.end === undefined) ||
      (item.start !== undefined && (item.end as number) <= (item.start as number))) fail("The range end must follow its start");
  if ((item.liveSessionId === undefined) !== (item.sourceRevision === undefined)) fail("A live reference needs its source revision");
  if (item.liveSessionId !== undefined && (item.previewTask !== undefined || item.sourceCommit !== undefined)) fail("A live reference cannot mix snapshot identifiers");
  if (item.compiledRevision !== undefined && item.liveSessionId === undefined) fail("A compiled revision needs its live session");
};
export const FrameReviewContextSchema = schema<FrameReviewContext>(review);
export const FrameBootstrapSchema = schema<FrameBootstrap>(object({ version: choice([1]), workId: uuid,
  projectId: text(), environmentId: text(), cwd: text(4096), label: text(160), userScope: text(128),
  parentOrigin: url, nonce: matching(/^[A-Za-z0-9_-]{24,128}$/),
  basePath: choice(["/ai/"]), embedPath: text(4096) }));
export const FrameFreezeInputSchema = schema<FrameFreezeInput>(object({ threadId: text(), messageId: uuid,
  text: text(2_000_000, 0), nativeProjectId: text(), cwd: text(4096),
  selection: object({ instanceId: text(), model: text() }) }, { reference: review, screenshots: array(() => {}, 20) }));
export const FrameFreezeResponseSchema = schema<FrameFreezeResponse>(object({ version: choice([1]), workId: uuid,
  threadId: text(), messageId: uuid, intentHash: sha, context: review, reviewReference: value => { record(value); } },
  { attachment: object({ type: choice(["text"]), mimeType: choice(["text/plain"]), text: text(2_000_000, 0) },
    { title: value => { if (value !== null) text(512, 0)(value); } }) }));
export const FrameOperationSchema = schema<FrameOperation>(choice(frameOperations));
export const FrameConnectSchema = schema<{ type: "frame-ai-connect"; version: 1; workId: string; nonce: string }>(
  object({ type: choice(["frame-ai-connect"]), version: choice([1]), workId: uuid,
    nonce: matching(/^[A-Za-z0-9_-]{24,128}$/) }));
export const FramePortRequestSchema = schema<FramePortRequest>(object({ type: choice(["request"]), id: uuid,
  op: choice(frameOperations), payload: () => {} }));
export const FramePortMessageSchema = schema<Record<string, unknown>>(value => {
  const item = record(value);
  if (item.type === "connected") object({ type: choice(["connected"]), version: choice([1]), workId: uuid, nonce: text(128) })(value);
  else if (item.type === "response") object({ type: choice(["response"]), id: uuid, ok: choice([true, false]) },
    item.ok === true ? { payload: () => {} } : { error: object({ code: text(), message: text(4096, 0) }) })(value);
  else object({ type: choice(["event"]), event: choice(["context.attach", "disposed"]), payload: () => {} })(value);
});
export const FrameContextAttachmentSchema = schema<FrameContextAttachment>(object({ id: text(), title: text(512),
  url, text: text(2_000_000, 0), resourceType: text() }, { identifier: text(), subtitle: text(4096, 0) }));
export const FrameContextAttachmentEventSchema = schema<{ threadId: string; item: FrameContextAttachment }>(
  object({ threadId: text(), item: value => { FrameContextAttachmentSchema.parse(value); } }));

export function frameReviewUrl(workId: string, context: FrameReviewContext, baseUrl: string): string {
  uuid(workId); const reference = { version: 1, workId, context: FrameReviewContextSchema.parse(context) };
  const value = new URL(baseUrl);
  if (!["http:", "https:"].includes(value.protocol)) fail("A FRAME review link must use HTTP or HTTPS");
  value.search = "";
  value.searchParams.set("frameReference", JSON.stringify(reference)); value.hash = "/work/" + workId;
  return value.href;
}

/** Read a persisted native message link without consulting the current player selection. */
export function readFrameReviewUrl(rawUrl: string | URL, workId: string): FrameReviewContext | null {
  const encoded = new URL(rawUrl).searchParams.get("frameReference");
  if (encoded === null) return null;
  if (encoded.length > 4096) fail("Oversized FRAME reference");
  const value = JSON.parse(encoded);
  object({ version: choice([1]), workId: uuid, context: review })(value);
  if (value.context.time === undefined && value.context.start === undefined) fail("Missing recorded position");
  return value.workId === workId ? value.context : null;
}

/** All attached references must describe one source; the latest timecode is the primary image. */
export function frameAttachedReview(items: readonly FrameContextAttachment[], workId: string): FrameReviewContext | undefined {
  let reference: FrameReviewContext | undefined;
  let provenance: string | undefined;
  const assets = new Set<string>();
  for (const item of items) {
    const context = readFrameReviewUrl(item.url, workId);
    if (!context) continue;
    const identity = JSON.stringify([context.liveSessionId, context.sourceRevision, context.compiledRevision, context.previewTask, context.sourceCommit]);
    if (provenance !== undefined && identity !== provenance) fail("Attached FRAME references use different preview versions. Remove the older reference before sending.");
    provenance = identity; reference = context;
    for (const asset of context.assets ?? []) assets.add(asset);
  }
  if (assets.size > 20) fail("A FRAME message can reference at most 20 materials");
  return reference ? { ...reference, ...(assets.size ? { assets: [...assets] } : {}) } : undefined;
}
