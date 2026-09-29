import http from "node:http";
import { once } from "node:events";

/** Test upstream, NOT a model implementation. Real installed CLIs still parse
 * protocol, call tools, pause for input and execute the returned command.
 */
export async function agentModelServer({ provider, command = "printf 'fixture command output\\n'", requestInput = true }) {
  const calls = [], toolsSeen = [];
  let stage = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    let input; try { input = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (req.url.includes("count_tokens")) { res.setHeader("Content-Type", "application/json"); res.end('{"input_tokens":80}'); return; }
    const tools = (input.tools || []).flatMap((tool) => tool.tools || [tool]);
    toolsSeen.push(tools.map((tool) => tool.name));
    const agent = provider === "codex" || tools.some((tool) => tool.name === "Bash");
    if (agent) calls.push(input);
    const step = agent ? stage++ : 99;
    const askStep = requestInput ? 0 : -1, commandStep = requestInput ? 1 : 0;
    if (provider === "claude") {
      const blocks = step === askStep ? [
        { type: "text", text: "我会先确认节奏，再修改动画。" },
        { type: "tool_use", id: "ask-fixture", name: "AskUserQuestion", input: { questions: [
          { header: "节奏", question: "开场采用哪种节奏？", multiSelect: false, options: [{ label: "紧凑", description: "更短的停顿" }, { label: "舒缓", description: "保留呼吸感" }] },
          { header: "保持", question: "哪些部分保持不变？", multiSelect: true, options: [{ label: "音乐", description: "保留当前配乐" }, { label: "字幕", description: "保留字幕内容" }] },
        ] } },
      ] : step === commandStep ? [{ type: "tool_use", id: "command-fixture", name: "Bash", input: { command, description: "修改动画并检查输出" } }] : [{ type: "text", text: "已按你的回答完成修改。\n\n**修改结果**：保留音乐与字幕，开场更紧凑。" }];
      const base = { id: `message-fixture-${agent ? step : 'aux-' + calls.length}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 80, output_tokens: 30 } };
      const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      if (!input.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...base, content: blocks, stop_reason: stop })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (type, more) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...more })}\n\n`);
      send("message_start", { message: base });
      for (const [index, block] of blocks.entries()) {
        send("content_block_start", { index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
        send("content_block_delta", { index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
        send("content_block_stop", { index });
      }
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } });
      send("message_stop", {}); res.end(); return;
    }
    const id = `response-fixture-${step}`, output = [];
    const message = (suffix, body, phase) => ({ type: "message", id: `message-${step}-${suffix}`, status: "completed", role: "assistant", ...(phase ? { phase } : {}), content: [{ type: "output_text", text: body, annotations: [] }] });
    if (step === askStep) {
      output.push({ type: "reasoning", id: "reasoning-fixture", summary: [{ type: "summary_text", text: "先确认创作方向，再修改和验证。" }] });
      output.push(message("progress", "我会先确认节奏，再修改动画。", "commentary"));
      const tool = tools.find((t) => t.name === "frame_ask_user");
      if (!tool) { res.writeHead(500); res.end("Missing frame_ask_user; tools: " + tools.map((t) => t.name).join(",")); return; }
      output.push({ type: "function_call", id: "ask-fixture", call_id: "ask-fixture", name: tool.name, arguments: JSON.stringify({ title: "确认创作方向", questions: [
        { id: "pace", header: "节奏", question: "开场采用哪种节奏？", options: [{ id: "tight", label: "紧凑", description: "更短的停顿" }, { id: "slow", label: "舒缓", description: "保留呼吸感" }] },
        { id: "keep", header: "保持", question: "哪些部分保持不变？", multiSelect: true, options: [{ id: "music", label: "音乐" }, { id: "subtitle", label: "字幕" }] },
      ] }), status: "completed" });
    } else if (step === commandStep) {
      const tool = tools.find((t) => ["exec_command", "shell_command", "shell"].includes(t.name));
      if (!tool) { res.writeHead(500); res.end("Missing shell tool"); return; }
      const args = tool.name === "exec_command" ? { cmd: command, yield_time_ms: 1000 } : tool.name === "shell_command" ? { command } : { command: ["bash", "-lc", command] };
      output.push({ type: "function_call", id: "command-fixture", call_id: "command-fixture", name: tool.name, arguments: JSON.stringify(args), status: "completed" });
    } else output.push(message("final", "已按你的回答完成修改。\n\n**修改结果**：保留音乐与字幕，开场更紧凑。", "final_answer"));
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (type, more) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...more })}\n\n`);
    send("response.created", { response: { id, status: "in_progress", model: input.model, output: [] } });
    output.forEach((item, index) => {
      send("response.output_item.added", { output_index: index, item });
      send("response.output_item.done", { output_index: index, item });
    });
    send("response.completed", { response: { id, status: "completed", model: input.model, output, usage: { input_tokens: 80, output_tokens: 30, total_tokens: 110 } } }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, calls, toolsSeen, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
