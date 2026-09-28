import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureInput } from "./production-input.mjs";

/** Disposable independent Git baseline, containing only the requested film. Never merges automatically. */
export function createProjectWorkspace(root, id) {
  const snapshot = captureInput(root, id, { workspace: true });
  try {
    const names = [
      "src",
      "templates",
      "docs",
      "index.html",
      "vite.config.ts",
      "vitest.config.ts",
      "playwright.config.ts",
      "AGENTS.md",
      ".gitignore",
      "README.md",
    ];
    for (const name of names) {
      const source = path.join(root, name);
      if (fs.existsSync(source))
        fs.cpSync(source, path.join(snapshot.root, name), {
          recursive: true,
          filter: (file) => {
            if (fs.lstatSync(file).isSymbolicLink())
              throw new Error("Workspace source links are not allowed");
            return true;
          },
        });
    }
    const git = (args) => {
      const result = spawnSync("git", args, {
        cwd: snapshot.root,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0)
        throw new Error(result.stderr || "Git workspace initialization failed");
      return result.stdout.trim();
    };
    git(["init", "-b", "codex/" + id]);
    fs.mkdirSync(path.join(snapshot.root, ".cache"), { recursive: true });
    fs.renameSync(
      path.join(snapshot.root, "input.json"),
      path.join(snapshot.root, ".cache/origin.json"),
    );
    fs.unlinkSync(path.join(snapshot.root, ".owner.json"));
    fs.appendFileSync(
      path.join(snapshot.root, ".git/info/exclude"),
      "\nnode_modules/\n.cache/\n.history/\n",
    );
    const tracked = [
      "src",
      "public",
      "scripts",
      "projects/" + id,
      "package.json",
      ...names.filter((name) => !["src"].includes(name)),
      "pnpm-lock.yaml",
      "tsconfig.json",
    ].filter((name) => fs.existsSync(path.join(snapshot.root, name)));
    git(["add", "--", ...new Set(tracked)]);
    git([
      "-c",
      "user.name=FRAME Workspace",
      "-c",
      "user.email=frame@localhost",
      "commit",
      "-m",
      "Initialize isolated film workspace",
    ]);
    return {
      status: "created",
      directory: snapshot.root,
      project: id,
      baseline: git(["rev-parse", "HEAD"]),
      input: snapshot.manifest.fingerprint,
      dependencyDirectory: fs.realpathSync(path.join(root, "node_modules")),
      instructions:
        "Edit only this copy. Run film scope here. Review its diff before explicitly copying changes back. Dependencies are shared read-only; do not install into this copy. Retain this directory while it contains work.",
    };
  } catch (error) {
    snapshot.close();
    throw error;
  }
}
