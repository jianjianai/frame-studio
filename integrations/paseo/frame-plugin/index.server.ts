import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFrameBackend } from "./server/backend";

/** Native Paseo owns receipts, history, permission UI and streams. Hooks only supply FRAME context. */
export default function contribute(server: PluginServerContext) {
  const backend = createFrameBackend();
  const remove: Array<() => void> = [];
  remove.push(
    server.before("agent.create", async ({ request }, { signal }) => {
      const context = await backend.context(signal);
      const existing = request.config.systemPrompt?.trim();
      return {
        ...request,
        config: {
          ...request.config,
          systemPrompt: [
            existing,
            context.instructions,
            "FRAME Git workflow: the main work workspace is the only draft automatically verified and applied to the published work. Managed Git worktrees remain isolated. Use native Paseo Git tools to finish and merge a worktree into the main workspace before FRAME validation and application. Worktree previews and FRAME work-tools use the selected agent checkout; they do not implicitly publish or merge that branch.",
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
