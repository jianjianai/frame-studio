import { z } from "zod";

const contextSchema = z.strictObject({
  version: z.literal(1),
  workId: z.uuid(),
  project: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64),
  instructions: z.string().min(1).max(2_000_000),
});
const envSchema = z.strictObject({
  version: z.literal(1),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    z.string().max(2_000_000),
  ),
});
type FrameEnvironment = Record<string, string | undefined>;
/** Capability stays in this daemon; redirects and response errors never expose its value. */
export function createFrameBackend(
  environment: FrameEnvironment = process.env,
  fetcher: typeof fetch = fetch,
) {
  const workId = z.uuid().parse(environment.FRAME_PASEO_WORK_ID);
  const base = new URL(z.url().parse(environment.FRAME_PASEO_URL));
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/api/paseo/internal/" + workId
  )
    throw Error("Invalid FRAME Paseo backend address");
  const capability = z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,128}$/)
    .parse(environment.FRAME_PASEO_TOKEN);
  let pendingContext: Promise<z.infer<typeof contextSchema>> | null = null;
  async function request(route: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetcher(base.href + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + capability,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Error(
        "FRAME Paseo backend request failed (" + response.status + ")",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("FRAME Paseo backend response is missing");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4 * 1024 * 1024)
          throw Error("FRAME Paseo backend response is too large");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(merged),
      );
    } catch {
      throw Error("FRAME Paseo backend response is invalid JSON");
    }
  }
  return {
    async context(signal?: AbortSignal) {
      pendingContext ||= request("/context", undefined, signal)
        .then((value) => {
          const context = contextSchema.parse(value);
          if (context.workId !== workId)
            throw Error("FRAME Paseo backend work identity changed");
          return context;
        })
        .catch((error) => {
          pendingContext = null;
          throw error;
        });
      return pendingContext;
    },
    async sessionOpen(
      input: {
        agentId: string;
        workspaceId: string | null;
        provider: string;
        cwd: string;
        reason: "create" | "resume" | "refresh" | "import";
        purpose: "interactive" | "history";
      },
      signal?: AbortSignal,
    ) {
      return envSchema.parse(
        await request("/session-open", { version: 1, ...input }, signal),
      ).env;
    },
    async event(
      type: string,
      input: { agentId?: string; workspaceId?: string | null },
      signal?: AbortSignal,
    ) {
      await request("/events", { version: 1, type, ...input }, signal);
    },
  };
}
