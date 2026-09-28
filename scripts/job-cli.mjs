import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectService } from "./project-service.mjs";
import { Jobs } from "./mcp/jobs.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      input: { type: "string" },
      id: { type: "string" },
      json: { type: "boolean" },
      launch: { type: "string" },
      timeout: { type: "string" },
    },
  });
  const [project, command] = positionals;
  const workspace = new ProjectService(process.cwd(), { projects: [project] });
  const jobs = new Jobs(workspace, {
    persistent: true,
    timeoutMs: Number(values.timeout ?? 3600) * 1000,
  });
  if (
    !Number.isFinite(jobs.timeoutMs) ||
    jobs.timeoutMs < 1000 ||
    jobs.timeoutMs > 86400000
  )
    throw new Error("Job timeout must be 1..86400 seconds");
  if (command === "worker") {
    const launch = workspace.file(
      project,
      ".cache/jobs/" + values.launch + ".json",
      true,
    );
    const request = JSON.parse(fs.readFileSync(launch, "utf8"));
    try {
      const state = jobs.start(project, request.kind, request.options);
      fs.writeFileSync(launch, JSON.stringify({ jobId: state.id }));
      await jobs.running.get(state.id).done;
    } catch (error) {
      fs.writeFileSync(launch, JSON.stringify({ error: error.message }));
      throw error;
    }
  } else if (command === "start") {
    const allowed = [
      "frame",
      "storyboard",
      "render",
      "review",
      "export",
      "validate",
      "typecheck",
      "test",
      "test-e2e",
      "build",
      "verify",
      "narrate",
      "playback",
    ];
    if (!allowed.includes(values.kind)) throw new Error("Unknown job kind");
    const options = values.input
      ? JSON.parse(
          fs.readFileSync(values.input === "-" ? 0 : values.input, "utf8"),
        )
      : {};
    const launchId = randomUUID(),
      launch = workspace.file(
        project,
        ".cache/jobs/" + launchId + ".json",
        true,
      );
    fs.mkdirSync(path.dirname(launch), { recursive: true });
    fs.writeFileSync(launch, JSON.stringify({ kind: values.kind, options }));
    const child = spawn(
      process.execPath,
      [
        import.meta.filename,
        project,
        "worker",
        "--launch",
        launchId,
        "--timeout",
        values.timeout ?? "3600",
      ],
      {
        cwd: workspace.root,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      },
    );
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      try {
        result = JSON.parse(fs.readFileSync(launch, "utf8"));
      } catch {}
      if (result?.jobId || result?.error) break;
      await delay(100);
    }
    if (result?.error) throw new Error(result.error);
    if (!result?.jobId)
      throw new Error("Worker startup did not confirm; inspect " + launch);
    fs.unlinkSync(launch);
    console.log(JSON.stringify(jobs.status(project, result.jobId)));
  } else if (command === "status" || command === "cancel") {
    const state = jobs.status(project, values.id);
    if (
      command === "cancel" &&
      ["running", "cancelling"].includes(state.status)
    ) {
      if (!state.persistent)
        throw new Error(
          "Cancel a session-owned MCP job through its owning session",
        );
      fs.writeFileSync(
        path.join(jobs.folder(project, values.id), "cancel.request"),
        "cancel",
      );
    }
    console.log(
      JSON.stringify({
        ...state,
        ...(command === "cancel" ? { cancellationRequested: true } : {}),
      }),
    );
  } else
    throw new Error(
      "Use film job <id> start --kind <kind> [--input JSON] | status --id UUID | cancel --id UUID",
    );
} catch (error) {
  console.log(JSON.stringify({ status: "failed", error: error.message }));
  process.exitCode = 1;
}
