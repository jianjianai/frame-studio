import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { command } from "./process.mjs";
import { confined, problem } from "./security.mjs";

export async function versionTree(repos, work, version, { detached = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(version))
    throw problem(400, "只能预览当前作品的 Git 历史版本");
  const { repo } = await repos.project(work.repo, work.project);
  const ancestor = await repos
    .git(repo.root, ["merge-base", "--is-ancestor", version, "HEAD"])
    .then(
      () => true,
      () => false,
    );
  // detached is reserved for a locally generated inverse commit; no API accepts this option.
  if (!ancestor && !detached) throw problem(400, "该版本不属于当前作品历史");
  const prefix = `projects/${work.project}/`;
  const output = await command(
    "git",
    ["ls-tree", "-rz", "--full-tree", version, "--", prefix],
    { cwd: repo.root, max: 4 * 1024 * 1024 },
  );
  const entries = output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, split).split(" ");
      const name = line.slice(split + 1);
      if (
        split < 0 ||
        !["100644", "100755"].includes(mode) ||
        type !== "blob" ||
        !/^[a-f0-9]{40}$/.test(oid) ||
        !name.startsWith(prefix)
      )
        throw problem(400, "历史版本包含不允许的链接或文件类型");
      const relative = name.slice(prefix.length);
      confined(path.join(repo.root, "projects", work.project), relative);
      return { mode, oid, path: relative };
    })
    .filter(
      (entry) =>
        !entry.path
          .split("/")
          .some((part) => ["exports", ".cache", ".history"].includes(part)),
    );
  if (!entries.some((entry) => entry.path === "project.ts"))
    throw problem(404, "历史版本缺少作品入口");
  if (entries.length > 20000)
    throw problem(413, "历史版本文件过多，无法在线预览");
  return { root: repo.root, entries };
}

// Copy immutable Git blobs, not a checkout. Never run hooks or change HEAD/index/work files.
async function copyBlob(root, oid, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const child = spawn("git", ["cat-file", "blob", oid], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error = (error + chunk).slice(-4000);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error || "读取历史文件失败")),
    );
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  try {
    await Promise.all([
      pipeline(child.stdout, fs.createWriteStream(target, { flags: "wx" })),
      exited,
    ]);
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function snapshotVersion(repos, work, version, destination, options = {}) {
  const tree = await versionTree(repos, work, version, options);
  if (fs.existsSync(destination)) throw problem(409, "历史预览输出已存在");
  fs.mkdirSync(destination, { recursive: true });
  // Avoid unbounded memory/file descriptors when a work contains many assets.
  for (let i = 0; i < tree.entries.length; i += 4) {
    const results = await Promise.allSettled(
      tree.entries
        .slice(i, i + 4)
        .map((entry) =>
          copyBlob(tree.root, entry.oid, confined(destination, entry.path)).then(() =>
            fs.chmodSync(confined(destination, entry.path), entry.mode === "100755" ? 0o755 : 0o644)),
        ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  // A committed media blob may be an LFS pointer, not the audio/image bytes.
  // Expand only validated pointers in our isolated copy; never checkout the live work.
  const pointers = [];
  for (const entry of tree.entries) {
    const target = confined(destination, entry.path);
    if (fs.statSync(target).size >= 1024) continue;
    const text = fs.readFileSync(target, "utf8");
    if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n"))
      continue;
    const match =
      /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n$/.exec(
        text,
      );
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw problem(409, "历史素材的 LFS 指针无效或使用了不支持的扩展");
    pointers.push({ target, oid: match[1], size: Number(match[2]) });
  }
  if (pointers.length) {
    const common = path.resolve(
      tree.root,
      await repos.git(tree.root, ["rev-parse", "--git-common-dir"]),
    );
    const storage = confined(common, "lfs");
    const objectPath = (pointer) =>
      confined(
        storage,
        `objects/${pointer.oid.slice(0, 2)}/${pointer.oid.slice(2, 4)}/${pointer.oid}`,
      );
    if (pointers.some((pointer) => !fs.existsSync(objectPath(pointer)))) {
      try {
        await repos.git(
          tree.root,
          [
            "-c",
            `lfs.storage=${storage}`,
            "-c",
            "lfs.fetchrecentalways=false",
            "lfs",
            "fetch",
            `--include=projects/${work.project}/**`,
            "--exclude=",
            "origin",
            version,
          ],
          true,
        );
      } catch {
        throw problem(
          409,
          "历史素材尚未下载且 LFS 获取失败，请检查仓库连接后重试预览",
        );
      }
    }
    for (const pointer of pointers) {
      const source = objectPath(pointer);
      if (!fs.existsSync(source) || fs.statSync(source).size !== pointer.size)
        throw problem(409, "历史素材缺失或大小校验失败");
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
      if (hash.digest("hex") !== pointer.oid)
        throw problem(409, "历史素材内容校验失败");
      fs.copyFileSync(source, pointer.target);
    }
  }
  return destination;
}
export async function compareVersion(repos, work, version) {
  const tree = await versionTree(repos, work, version);
  const head = await repos.git(tree.root, ["rev-parse", "HEAD"]);
  const output = await command(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      version,
      "--",
      `projects/${work.project}/`,
    ],
    { cwd: tree.root, max: 1024 * 1024 },
  );
  const fields = output.split("\0"),
    changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (fields[i])
      changes.push({
        status: fields[i],
        path: fields[i + 1].replace(`projects/${work.project}/`, ""),
      });
  const untracked = await command(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      `projects/${work.project}/`,
    ],
    { cwd: tree.root, max: 1024 * 1024 },
  );
  for (const name of untracked.split("\0").filter(Boolean))
    changes.push({
      status: "A",
      path: name.replace(`projects/${work.project}/`, ""),
    });
  return {
    version,
    current: head,
    changes: changes.slice(0, 500),
    total: changes.length,
    truncated: changes.length > 500,
    comparison: "selected-to-current",
    note: "列出所选版本到当前作品（含未提交修改）的文件变化。预览不会恢复或修改当前作品。",
  };
}
