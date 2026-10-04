#!/usr/bin/env node
// Adapted from the pinned upstream ClaudeCapabilitiesProbe and ClaudeAdapter IPC fixtures.
// This fixture implements local stdin/stdout only and never imports an API client or opens a socket.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const record = value => process.env.FRAME_FAKE_CLAUDE_CAPTURE && appendFileSync(process.env.FRAME_FAKE_CLAUDE_CAPTURE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, ...value }) + "\n");
if (args.includes("--version")) { console.log("2.1.283 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })); process.exit(0); }
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.once("end", () => { console.log(JSON.stringify({ result: "Claude smoke", is_error: false })); process.exit(0); });
} else {
  const sessionId = randomUUID();
  const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const value = JSON.parse(line);
    if (value.type === "control_request") {
      record({ kind: "control", request: value.request });
      let response = {};
      if (value.request?.subtype === "initialize") response = { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: { tokenSource: "api_key", apiProvider: "firstParty" } };
      if (value.request?.subtype === "get_usage") response = { session: {}, rate_limits_available: false, rate_limits: {}, behaviors: null };
      emit({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response } });
      return;
    }
    if (value.type !== "user") return;
    record({ kind: "user", message: value, env: Object.fromEntries(["FRAME_WORK_ID", "FRAME_PROJECT", "FRAME_THREAD_ID", "FRAME_AGENT_TOKEN", "FRAME_AGENT_URL", "FRAME_AI_CONTROL_FILE", "FRAME_CALLBACK_URL", "CLAUDE_CONFIG_DIR"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
    const assistantId = randomUUID(), messageUuid = randomUUID();
    const message = { id: assistantId, type: "message", role: "assistant", model: "owned-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    emit({ type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId, cwd: process.cwd(), tools: [], mcp_servers: [], model: "owned-claude", permissionMode: "bypassPermissions", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.283" });
    const stream = event => emit({ type: "stream_event", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, event });
    stream({ type: "message_start", message });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    setTimeout(() => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude " } }), 150);
    setTimeout(() => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture complete" } }), 500);
    setTimeout(() => {
      stream({ type: "content_block_stop", index: 0 });
      stream({ type: "message_stop" });
      emit({ type: "assistant", session_id: sessionId, uuid: messageUuid, parent_tool_use_id: null, message: { ...message, content: [{ type: "text", text: "Claude fixture complete" }], stop_reason: "end_turn" } });
      emit({ type: "result", subtype: "success", is_error: false, errors: [], session_id: sessionId, uuid: randomUUID(), result: "Claude fixture complete", duration_ms: 650, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] });
    }, 650);
  });
}
