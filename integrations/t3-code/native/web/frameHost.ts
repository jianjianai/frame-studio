import { randomUUID } from "../lib/utils";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { readProjects, readThreadShell } from "../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId } from "@t3tools/contracts";
import { FrameBootstrapSchema, FrameFreezeInputSchema, FrameFreezeResponseSchema,
  FrameContextAttachmentEventSchema, FramePortMessageSchema, frameAttachedReview, type FrameContextAttachment,
  type FrameBootstrap, type FrameOperation } from "./shared/bridge";

const rawBootstrap = (window as Window & { __FRAME_AI__?: unknown }).__FRAME_AI__;
export const frameBootstrap: FrameBootstrap | null = rawBootstrap ? FrameBootstrapSchema.parse(rawBootstrap) : null;
export const isFrameEmbedded = () => frameBootstrap !== null && window.parent !== window;
export const frameRouterBase = () => isFrameEmbedded() ? frameBootstrap!.embedPath : "/ai/";

type ActiveContext = { threadId: string; nativeProjectId: string; cwd: string; standaloneUrl: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
let active: ActiveContext | null = null;
let port: MessagePort | null = null;
let connection: Promise<void> | null = null;
const pending = new Map<string, Pending>();
const attachments = new Map<string, readonly FrameContextAttachment[]>();
const listeners = new Set<() => void>();
const emptyAttachments: readonly FrameContextAttachment[] = Object.freeze([]);
export const subscribeFrameReferences = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readFrameReferences = (threadId: string) => attachments.get(threadId) ?? emptyAttachments;
export function removeFrameReference(threadId: string, id: string) {
  attachments.set(threadId, readFrameReferences(threadId).filter(item => item.id !== id));
  listeners.forEach(listener => listener());
}
function dispose() {
  port?.close(); port = null; connection = null;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("FRAME connection closed")); }
  pending.clear();
}
async function connect(): Promise<void> {
  if (!isFrameEmbedded()) throw new Error("This chat is not embedded in FRAME");
  if (port) return;
  if (connection) return connection;
  connection = new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); connection = null; reject(new Error("FRAME connection timed out")); }, 10000);
    channel.port1.onmessage = event => {
      const parsed = FramePortMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "connected") {
        if (message.workId !== frameBootstrap!.workId || message.nonce !== frameBootstrap!.nonce) return;
        clearTimeout(timeout); port = channel.port1; resolve();
      } else if (message.type === "response") {
        const request = pending.get(message.id as string); if (!request) return;
        pending.delete(message.id as string); clearTimeout(request.timer);
        if (message.ok) request.resolve(message.payload);
        else request.reject(new Error((message.error as { message?: string })?.message ?? "FRAME request failed"));
      } else if (message.event === "context.attach") {
        const attachment = FrameContextAttachmentEventSchema.safeParse(message.payload);
        if (!attachment.success || attachment.data.threadId !== active?.threadId || active.nativeProjectId !== frameBootstrap!.projectId) return;
        const { threadId, item } = attachment.data;
        attachments.set(threadId, [...readFrameReferences(threadId).filter(value => value.id !== item.id), item]);
        listeners.forEach(listener => listener());
      } else if (message.event === "disposed") dispose();
    };
    channel.port1.start();
    window.parent.postMessage({ type: "frame-ai-connect", version: 1, workId: frameBootstrap!.workId, nonce: frameBootstrap!.nonce }, frameBootstrap!.parentOrigin, [channel.port2]);
  });
  return connection;
}
export async function requestFrame(op: FrameOperation, payload: unknown): Promise<unknown> {
  await connect();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("FRAME request timed out")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    port!.postMessage({ type: "request", id, op, payload });
  });
}
export function setFrameActiveContext(context: ActiveContext | null) {
  active = context;
  if (!isFrameEmbedded() || !context || context.nativeProjectId !== frameBootstrap!.projectId) return;
  void requestFrame("context.subscribe", context).catch(error => console.error("FRAME context subscription failed", error));
}
async function beforeTurn(input: StartThreadTurnInput): Promise<StartThreadTurnInput> {
  if (!isFrameEmbedded()) return input;
  const thread = readThreadShell(scopeThreadRef(EnvironmentId.make(frameBootstrap!.environmentId), input.threadId));
  const projectId = input.bootstrap?.createThread?.projectId ?? thread?.projectId ??
    (active?.threadId === input.threadId ? active.nativeProjectId : null);
  if (projectId !== frameBootstrap!.projectId) throw new Error("Open this project's chat from its FRAME work page");
  const project = readProjects().find(value => value.id === projectId && value.environmentId === frameBootstrap!.environmentId);
  if (!project || project.workspaceRoot !== frameBootstrap!.cwd || input.bootstrap?.prepareWorktree) throw new Error("FRAME uses the canonical project workspace");
  const selection = input.modelSelection ?? input.bootstrap?.createThread?.modelSelection ?? thread?.modelSelection;
  if (!selection) throw new Error("Choose a native provider and model before sending");
  const refs = readFrameReferences(input.threadId);
  const text = [input.message.text, ...refs.map(item => item.text)].filter(Boolean).join("\n\n");
  const payload = FrameFreezeInputSchema.parse({ threadId: input.threadId, messageId: input.message.messageId,
    nativeProjectId: projectId, cwd: project.workspaceRoot, text,
    selection: { instanceId: selection.instanceId, model: selection.model }, reference: frameAttachedReview(refs, frameBootstrap!.workId) });
  const frozen = FrameFreezeResponseSchema.parse(await requestFrame("freeze.submit", payload));
  if (frozen.threadId !== input.threadId || frozen.messageId !== input.message.messageId || frozen.workId !== frameBootstrap!.workId) throw new Error("FRAME froze a different chat message");
  return { ...input, message: { ...input.message, text: [text, frozen.attachment?.text].filter(Boolean).join("\n\n") } };
}
export function initializeFrameHost() {
  if (!isFrameEmbedded()) return;
  document.documentElement.dataset.frameEmbedded = "true";
  globalThis.__FRAME_AI_INTERCEPT_TURN__ = beforeTurn;
  globalThis.__FRAME_AI_TURN_ACCEPTED__ = input => {
    attachments.delete(input.threadId); listeners.forEach(listener => listener());
    void requestFrame("message.accepted", { threadId: input.threadId, messageId: input.message.messageId }).catch(error => console.error("FRAME message receipt failed", error));
  };
  window.addEventListener("pagehide", dispose, { once: true });
  document.addEventListener("click", event => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const url = new URL(anchor.href);
    if (url.searchParams.has("frameReference")) { event.preventDefault(); void requestFrame("preview.open", { url: url.href }); }
  });
}
