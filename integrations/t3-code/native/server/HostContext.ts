import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";

const FrameContext = Schema.Struct({ version: Schema.Literal(1), workId: Schema.String, project: Schema.String,
  instructions: Schema.String, env: Schema.Record(Schema.String, Schema.String) });
export class FrameContextError extends Schema.TaggedError<FrameContextError>()("FrameContextError", { cause: Schema.Defect() }) {
  override get message() { return "FRAME could not resolve this thread's project context."; }
}
/** Never cache a project's credentials on a provider instance: one instance serves many threads. */
export const readFrameContext = (input: { threadId: string; cwd?: string; provider: string }) => Effect.tryPromise({
  try: async () => {
    const baseUrl = process.env.FRAME_CALLBACK_URL;
    if (!baseUrl) return null;
    const control = JSON.parse(await readFile(process.env.FRAME_AI_CONTROL_FILE ?? "/data/ai/shared/control.json", "utf8"));
    const response = await fetch(new URL("/api/ai/internal/context", baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.secret}` },
      body: JSON.stringify({ version: 1, threadId: input.threadId, cwd: input.cwd ?? process.cwd(), provider: input.provider }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`FRAME context HTTP ${response.status}`);
    const value = await response.json();
    return value === null ? null : Schema.decodeUnknownSync(FrameContext)(value);
  }, catch: cause => new FrameContextError({ cause }),
});
export function frameAgentEnvironment(nativeEnvironment: NodeJS.ProcessEnv, frameEnvironment?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const output = { ...nativeEnvironment };
  // Control credentials are for the services, never tools launched in a project.
  for (const name of ["FRAME_AI_CONTROL_FILE", "FRAME_CALLBACK_URL", "FRAME_T3_TOKEN", "FRAME_T3_HOST_SECRET", "T3CODE_DEV_AUTH_TOKEN"]) delete output[name];
  for (const name of ["FRAME_PROJECT", "FRAME_WORK_ID", "FRAME_AGENT_ID", "FRAME_AGENT_TOKEN", "FRAME_AGENT_URL", "FRAME_REFERENCE_ROOT", "FRAME_THREAD_ID", "FRAME_SHARED_RUNTIME_ROOT"]) {
    delete output[name]; if (frameEnvironment?.[name]) output[name] = frameEnvironment[name];
  }
  return output;
}
