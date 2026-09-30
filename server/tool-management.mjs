import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { toolBinary } from "./connections.mjs";
import { command } from "./process.mjs";
import { problem } from "./security.mjs";
import {
  ToolReleases,
  toolDefinitions,
  installedToolVersion,
  normalizeToolVersion,
  compareToolVersions,
} from "./tool-releases.mjs";

export function toolManagementOperations({
  add,
  db,
  data,
  tasks,
  releases = new ToolReleases(),
  run = command,
}) {
  const localMode = process.env.FRAME_LOCAL_MODE === "1";
  const probes = new Map();
  const probeVersion = (tool) => {
    let bin;
    try {
      bin = toolBinary(data, tool);
    } catch {
      return Promise.resolve({ version: null, available: false });
    }
    const cached = probes.get(tool);
    if (cached?.bin === bin && Date.now() < cached.expires) return cached.value;
    const value = Promise.resolve()
      .then(() => run(bin, ["--version"], { timeout: 10000, max: 4096 }))
      .then(
        (output) => ({ version: output, available: true }),
        () => ({ version: null, available: false }),
      );
    probes.set(tool, { bin, value, expires: Date.now() + 10000 });
    return value;
  };
  const info = (force = false) =>
    Promise.all(
      Object.entries(toolDefinitions).map(async ([tool, definition]) => {
        const [probe, release, updates, entries] = await Promise.all([
          probeVersion(tool),
          releases.check(tool, { force }),
          db.all(
            "SELECT id,state,input,result,error,progress,created,started,finished FROM tasks WHERE kind='tools-update' AND input->>'provider'=$1 ORDER BY created DESC,id DESC LIMIT 5",
            [tool],
          ),
          localMode
            ? []
            : fs
                .readdir(path.join(data, "tools", tool), {
                  withFileTypes: true,
                })
                .catch((error) => {
                  if (error.code === "ENOENT") return [];
                  throw error;
                }),
        ]);
        const installedVersion = installedToolVersion(probe.version || "");
        const installedVersions = entries
          .filter((entry) => {
            if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
            try {
              return normalizeToolVersion(entry.name) === entry.name;
            } catch {
              return false;
            }
          })
          .map((entry) => entry.name)
          .sort((a, b) => compareToolVersions(b, a));
        return {
          tool,
          ...definition,
          ...probe,
          installedVersion,
          installedVersions,
          localMode,
          release,
          updates,
          updateAvailable:
            release.latestVersion && installedVersion
              ? compareToolVersions(release.latestVersion, installedVersion) > 0
              : null,
        };
      }),
    );
  add(
    "tools_info",
    "Installed CLI versions, cached official release checks and live update tasks",
    {},
    () => info(),
  );
  add(
    "tools_check_updates",
    "Refresh official latest-version information for both creation tools",
    {},
    () => info(true),
  );
  add(
    "tools_update",
    "Resolve latest or a specific official CLI version, then install it in the background",
    {
      provider: z.enum(["codex", "claude"]),
      version: z.string().trim().min(1).max(80).default("latest"),
    },
    async ({ provider, version: requestedVersion }) => {
      if (localMode)
        throw problem(
          400,
          "本地模式使用电脑上的 CLI，请通过其官方安装方式更新。",
        );
      const active = await db.one(
        "SELECT id FROM tasks WHERE kind='tools-update' AND state IN ('queued','running') LIMIT 1",
      );
      if (active)
        throw problem(409, "另一项工具更新正在进行，请等待完成后再试。");
      const version = await releases.resolve(provider, requestedVersion);
      return tasks.create({
        kind: "tools-update",
        input: { provider, version, requestedVersion },
      });
    },
  );
}
