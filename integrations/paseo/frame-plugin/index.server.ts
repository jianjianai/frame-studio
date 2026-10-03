import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFrameBackend } from "./server/backend";

/** Native Paseo owns receipts, history, permission UI and streams. Hooks only supply FRAME context. */
export default function contribute(server: PluginServerContext) {
  const backend = createFrameBackend();
  const remove: Array<() => void> = [];
  remove.push(server.before("workspace.create", ({ request }) => {
    if (request.source.kind !== "directory" || request.source.path !== process.cwd())
      throw new Error("FRAME 作品只使用一个共享工作区；请在当前作品中新建对话。");
    return request;
  }));
  remove.push(
    server.before("agent.create", async ({ request }, { signal }) => {
      if (request.config.cwd !== process.cwd())
        throw new Error("FRAME 对话必须使用当前作品的共享工作区。");
      const context = await backend.context(signal);
      const existing = request.config.systemPrompt?.trim();
      return {
        ...request,
        config: {
          ...request.config,
          systemPrompt: [
            existing,
            context.instructions,
            "FRAME uses this checkout as the sole editable work workspace. All conversations, the editor, preview and work tools share these files and the same Git index. Do not create or switch worktrees or copy a draft for editing. Saved changes appear in the live preview directly. FRAME validates this exact revision in the current runtime; failed validation retains your changes. Long exports freeze a temporary read-only input and never write back to this workspace.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      };
    }),
  );
  remove.push(
    server.before("agent.session_open", async ({ request }, { signal }) => {
      const { env: _oldEnvironment, ...opening } = request;
      const fresh = await backend.sessionOpen(opening, signal);
      return {
        ...request,
        env: {
          ...request.env,
          ...fresh,
          FRAME_PASEO_WORK_ID: process.env.FRAME_PASEO_WORK_ID!,
          FRAME_PASEO_TOKEN: process.env.FRAME_PASEO_TOKEN!,
          FRAME_PASEO_URL: process.env.FRAME_PASEO_URL!,
          FRAME_AGENT_TOKEN:
            fresh.FRAME_AGENT_TOKEN ||
            process.env.FRAME_AGENT_TOKEN ||
            process.env.FRAME_PASEO_TOKEN!,
          FRAME_AGENT_URL:
            process.env.FRAME_AGENT_URL ||
            new URL(process.env.FRAME_PASEO_URL!).origin,
        },
      };
    }),
  );
  for (const name of [
    "agent.created",
    "agent.turn_started",
    "agent.turn_ended",
    "agent.permission_requested",
    "agent.permission_resolved",
    "agent.archived",
  ] as const) {
    remove.push(
      server.on(name, async (event, { signal }) => {
        // A lifecycle hint may be lost during reconnect; durable source reconciliation remains authoritative.
        await backend
          .event(
            name,
            {
              agentId: event.agent.id,
              ...(event.agent.workspaceId
                ? { workspaceId: event.agent.workspaceId }
                : {}),
            },
            signal,
          )
          .catch(() => {});
      }),
    );
  }
  for (const name of ["workspace.created", "workspace.archived"] as const) {
    remove.push(
      server.on(name, async (event, { signal }) => {
        await backend
          .event(name, { workspaceId: event.workspace.id }, signal)
          .catch(() => {});
      }),
    );
  }
  return () => {
    for (const unregister of remove.splice(0)) unregister();
  };
}
