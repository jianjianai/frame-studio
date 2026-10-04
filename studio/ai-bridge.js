import { randomUUID } from "../src/browser/uuid.mjs";
import {
  FrameBootstrapSchema,
  FrameConnectSchema,
  FramePortRequestSchema,
  FrameReviewContextSchema,
  FrameFreezeInputSchema,
  FrameFreezeResponseSchema,
  FrameContextAttachmentEventSchema,
} from "../integrations/t3-code/shared/bridge.mjs";
import { aiReferenceUrl, readAiReference } from "./ai-reference.mjs";
const validThreadId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Only this trusted, same-origin official iframe may use the work-scoped port. */
export function aiBridge({
  iframe,
  bootstrap,
  getContext,
  freeze,
  onAccepted,
  onActiveThread,
  onPreview,
  onResults,
  onClose,
  onConnection,
}) {
  const config = FrameBootstrapSchema.parse(bootstrap),
    controller = new AbortController();
  if (
    config.parentOrigin !== location.origin ||
    config.basePath !== "/ai/" ||
    config.embedPath !== `/ai/works/${config.workId}/`
  )
    throw new Error("T3 Code 作品连接范围无效");
  let port = null,
    disposed = false;
  const pending = new Map();
  const seen = new Set();
  const post = (data) => {
    if (!disposed && port) port.postMessage(data);
  };
  function endPort() {
    for (const pendingController of pending.values()) pendingController.abort();
    pending.clear();
    seen.clear();
    if (port) {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    }
    port = null;
  }
  const message = (event) => {
    const parsed = FrameConnectSchema.safeParse(event.data);
    if (!parsed.success) return;
    const next = event.ports[0];
    const source = new URL(iframe.src, location.href);
    if (
      disposed ||
      event.source !== iframe.contentWindow ||
      event.origin !== location.origin ||
      parsed.data.workId !== config.workId ||
      parsed.data.nonce !== config.nonce ||
      source.origin !== location.origin ||
      source.pathname !== config.embedPath ||
      source.searchParams.get("frameNonce") !== config.nonce
    ) {
      next?.close();
      return;
    }
    if (!next) return;
    endPort();
    onActiveThread?.(null);
    port = next;
    port.onmessage = async (event) => {
      let input;
      try {
        const encoded = JSON.stringify(event.data);
        if (new TextEncoder().encode(encoded).byteLength > 2100000)
          throw new Error("请求过大");
        input = FramePortRequestSchema.parse(event.data);
      } catch {
        return;
      }
      if (seen.has(input.id)) return;
      if (pending.size >= 32) {
        post({
          type: "response",
          id: input.id,
          ok: false,
          error: { code: "busy", message: "作品请求过多，请稍后重试。" },
        });
        return;
      }
      seen.add(input.id);
      if (seen.size > 128) seen.delete(seen.values().next().value);
      const requestController = new AbortController();
      pending.set(input.id, requestController);
      const activePort = port;
      try {
        let payload = {};
        const value = input.payload;
        if (input.op === "context.read")
          payload = FrameReviewContextSchema.parse(getContext());
        else if (input.op === "context.subscribe") {
          if (!validThreadId(value?.threadId)) throw new Error("当前对话无效");
          if (
            value.nativeProjectId !== config.projectId ||
            value.cwd !== config.cwd
          )
            throw new Error("当前对话不属于此作品");
          onActiveThread?.(value.threadId, {
            standaloneUrl: value.standaloneUrl,
          });
          payload = FrameReviewContextSchema.parse(getContext());
        } else if (input.op === "context.attach") {
          if (!validThreadId(value?.threadId)) throw new Error("当前对话无效");
          const context = FrameReviewContextSchema.parse(getContext());
          const item = {
            id: randomUUID(),
            identifier: "frame-preview",
            title:
              context.start !== undefined
                ? `作品 ${context.start.toFixed(2)}–${context.end.toFixed(2)} 秒`
                : `作品 ${(context.time ?? 0).toFixed(2)} 秒`,
            subtitle: `${context.assets?.length ?? 0} 个所选素材`,
            url: aiReferenceUrl(config.workId, context, location.href),
            text: JSON.stringify({ workId: config.workId, context }, null, 2),
            resourceType: "frame-reference",
          };
          post({
            type: "event",
            event: "context.attach",
            payload: { threadId: value.threadId, item },
          });
          payload = { attached: true };
        } else if (input.op === "freeze.submit")
          payload = FrameFreezeResponseSchema.parse(
            await freeze(
              FrameFreezeInputSchema.parse(value),
              requestController.signal,
            ),
          );
        else if (input.op === "message.accepted") {
          if (
            !validThreadId(value?.threadId) ||
            !uuid.test(value?.messageId ?? "")
          )
            throw new Error("发送回执无效");
          onAccepted?.(value);
          payload = { accepted: true };
        } else if (input.op === "preview.open") {
          let reference;
          if (value?.url !== undefined) {
            if (typeof value.url !== "string" || value.url.length > 8192)
              throw new Error("画面引用链接无效。");
            reference = readAiReference(value.url, config.workId);
            if (!reference) throw new Error("画面引用不属于此作品。");
          }
          onPreview?.(reference);
        } else if (input.op === "results.open") onResults?.();
        else if (input.op === "dock.close") onClose?.();
        if (!requestController.signal.aborted && port === activePort)
          post({ type: "response", id: input.id, ok: true, payload });
      } catch (error) {
        if (!requestController.signal.aborted && port === activePort)
          post({
            type: "response",
            id: input.id,
            ok: false,
            error: {
              code:
                typeof error.code === "string"
                  ? error.code
                  : "frame_request_failed",
              message: (error.message || String(error)).slice(0, 4096),
            },
          });
      } finally {
        if (pending.get(input.id) === requestController)
          pending.delete(input.id);
      }
    };
    port.onmessageerror = () => {
      endPort();
      onActiveThread?.(null);
      onConnection?.("error");
    };
    port.start();
    post({
      type: "connected",
      version: 1,
      workId: config.workId,
      nonce: config.nonce,
    });
    onConnection?.("ready");
  };
  window.addEventListener("message", message, { signal: controller.signal });
  return {
    attach(thread, item) {
      const payload = FrameContextAttachmentEventSchema.parse({
        threadId: thread,
        item,
      });
      if (!port) throw new Error("T3 Code 尚未连接，请重新连接后重试。");
      post({ type: "event", event: "context.attach", payload });
    },
    dispose() {
      if (disposed) return;
      post({ type: "event", event: "disposed", payload: {} });
      disposed = true;
      controller.abort();
      endPort();
      onConnection?.("closed");
    },
  };
}
