import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { confinedAsync, sourceGitStatus } from "./project-files.mjs";
import { problem, relativeParts } from "./security.mjs";

const ROOT_FILES = new Set(["README.md", ".gitattributes", ".gitignore"]);
const TEXT_LIMIT = 192 * 1024;
const FILE_LIMIT = 2000;
const literal = (file) => ":(literal)" + file;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const missing = () => ({ kind: "missing", bytes: 0, text: "" });

// Unlike the general command helper, never trim file contents or silently truncate Git records.
function readGit(root, args, { max = 4 * 1024 * 1024, codes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "protocol.file.allow=never",
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const chunks = [];
    let size = 0,
      failure,
      stderr = "";
    const timer = setTimeout(() => {
      failure = problem(504, "读取 Git 超时，请重试");
      child.kill("SIGKILL");
    }, 30000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        failure = problem(413, "内容超出在线查看上限，请使用本地 Git 查看");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!codes.includes(code))
        reject(problem(409, "无法读取 Git 状态：" + stderr.trim()));
      else resolve(Buffer.concat(chunks));
    });
  });
}
const gitText = async (root, args, options) =>
  (await readGit(root, args, options)).toString("utf8");
const revisionOf = async (root, ref) =>
  (
    await gitText(root, ["rev-parse", "--verify", "--quiet", ref], {
      codes: [0, 1],
    })
  ).trim() || null;

export function parseSourceStatus(raw) {
  const records = raw.split("\0"),
    files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const fields = record.split(" ");
    if (record.startsWith("? "))
      files.push({
        path: record.slice(2),
        index: "?",
        working: "?",
        status: "A",
        untracked: true,
      });
    else if (["1", "2", "u"].includes(fields[0])) {
      const rename = fields[0] === "2",
        conflict = fields[0] === "u";
      files.push({
        path: fields.slice(conflict ? 10 : rename ? 9 : 8).join(" "),
        ...(rename ? { originalPath: records[++i] } : {}),
        index: fields[1][0],
        working: fields[1][1],
        conflict,
        indexMode: conflict ? null : fields[4],
        status: conflict ? "U" : fields[1].replaceAll(".", "")[0] || "M",
      });
    } else throw problem(409, "无法识别 Git 状态，请刷新后重试");
  }
  return files;
}
function inScope(work, file) {
  return (
    typeof file === "string" &&
    (file.startsWith(`projects/${work.project}/`) || ROOT_FILES.has(file))
  );
}
function validatePath(work, file) {
  const parts = relativeParts(file);
  if (
    !inScope(work, file) ||
    parts.some((p) => ["exports", ".cache", ".history"].includes(p))
  )
    throw problem(400, "只能操作当前作品的源文件和分支说明文件");
  return file;
}
async function signature(root, file) {
  try {
    const target = await confinedAsync(root, file);
    const stat = await fs.lstat(target, { bigint: true });
    if (!stat.isFile()) return ["unsafe", "不支持目录、链接或特殊文件"];
    // Git index OIDs cover staged content; nanosecond inode metadata detects working-file changes
    // without repeatedly hashing gigabytes of modified media for a status panel.
    return [
      String(stat.dev),
      String(stat.ino),
      String(stat.size),
      String(stat.mtimeNs),
      String(stat.ctimeNs),
      String(stat.mode),
    ];
  } catch (error) {
    if (error.code === "ENOENT") return ["missing"];
    if (error.statusCode === 400)
      return ["unsafe", "链接、敏感路径或特殊文件不允许在线操作"];
    throw error;
  }
}
export async function sourceSnapshot(repos, work) {
  const { repo } = await repos.project(work.repo, work.project, {
    exists: false,
  });
  const raw = await sourceGitStatus(args => gitText(repo.root, args));
  const all = parseSourceStatus(raw);
  if (all.length > FILE_LIMIT)
    throw problem(413, `变更超过 ${FILE_LIMIT} 个文件，请先使用本地 Git 整理`);
  const head = await revisionOf(repo.root, "HEAD");
  const branch = (
    await gitText(repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      codes: [0, 1],
    })
  ).trim();
  const mergeHead = await revisionOf(repo.root, "MERGE_HEAD");
  const gitDir = (
    await gitText(repo.root, ["rev-parse", "--absolute-git-dir"])
  ).trim();
  const rebase = (
    await Promise.all(
      ["rebase-merge", "rebase-apply", "sequencer"].map((name) =>
        fs.access(path.join(gitDir, name)).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).some(Boolean);
  const fingerprints = [],
    files = [];
  for (const file of all) {
    const sig = await signature(repo.root, file.path);
    fingerprints.push([file.path, sig]);
    if (
      !inScope(work, file.path) ||
      (file.originalPath && !inScope(work, file.originalPath))
    )
      continue;
    let unsafe = sig[0] === "unsafe" ? sig[1] : null;
    try {
      validatePath(work, file.path);
      if (file.originalPath) validatePath(work, file.originalPath);
    } catch {
      unsafe = "该路径不允许在线操作";
    }
    if (
      file.indexMode &&
      !["000000", "100644", "100755"].includes(file.indexMode)
    )
      unsafe ||= "暂存区包含链接或不支持的文件类型";
    files.push({ ...file, unsafe });
  }
  return {
    repo,
    head,
    branch,
    files,
    outside: all.length - files.length,
    outsideStaged: all.some(
      (file) =>
        !files.some((entry) => entry.path === file.path) &&
        file.index !== "." &&
        file.index !== "?",
    ),
    merging: !!mergeHead || rebase,
    revision: digest(
      JSON.stringify([head, branch, mergeHead, rebase, raw, fingerprints]),
    ),
  };
}
export async function assertSourceRevision(repos, work, expected) {
  const snapshot = await sourceSnapshot(repos, work);
  if (expected && expected !== snapshot.revision)
    throw problem(409, "文件或暂存区已变化，请重新查看差异后再操作");
  return snapshot;
}
function safeSnapshot(work, snapshot) {
  if (!work.branch || snapshot.branch !== work.branch)
    throw problem(409, "当前检出分支与作品分支不一致，已停止写入");
  if (snapshot.merging || snapshot.files.some((file) => file.conflict))
    throw problem(
      409,
      "存在未完成的合并或冲突，请先在本地 Git 解决；不会自动选择任意一侧",
    );
}
function publicSide({ text, ...side }) {
  return side;
}
function textSide(buffer, extra = {}) {
  if (buffer.includes(0))
    return { kind: "binary", bytes: buffer.length, ...extra };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { kind: "binary", bytes: buffer.length, ...extra };
  }
  const lfs =
    /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)/.exec(
      text,
    );
  if (lfs) return { kind: "lfs", bytes: Number(lfs[2]), oid: lfs[1], ...extra };
  return { kind: "text", bytes: buffer.length, text, ...extra };
}
async function blob(root, oid, mode) {
  if (!["100644", "100755"].includes(mode))
    return { kind: "unsupported", bytes: 0, mode };
  const bytes = Number((await gitText(root, ["cat-file", "-s", oid])).trim());
  if (bytes > TEXT_LIMIT) return { kind: "large", bytes, oid, mode };
  return textSide(
    await readGit(root, ["cat-file", "blob", oid], { max: TEXT_LIMIT }),
    { oid, mode },
  );
}
async function gitSide(root, file, ref, stage = 0) {
  if (!ref) return missing();
  if (ref === "index") {
    const output = await gitText(root, [
      "ls-files",
      "--stage",
      "-z",
      "--",
      literal(file),
    ]);
    const entry = output
      .split("\0")
      .find(
        (line) =>
          line.slice(line.indexOf("\t") + 1) === file &&
          line.slice(0, line.indexOf("\t")).endsWith(" " + stage),
      );
    if (!entry) return missing();
    const [mode, oid] = entry.split(" ");
    return blob(root, oid, mode);
  }
  const output = await gitText(root, [
    "ls-tree",
    "-z",
    ref,
    "--",
    literal(file),
  ]);
  const entry = output
    .split("\0")
    .find((line) => line.slice(line.indexOf("\t") + 1) === file);
  if (!entry) return missing();
  const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (type !== "blob") return { kind: "unsupported", bytes: 0, mode };
  return blob(root, oid, mode);
}
async function workingSide(root, file) {
  const target = await confinedAsync(root, file);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return missing();
    throw error;
  }
  if (!stat.isFile()) return { kind: "unsupported", bytes: stat.size };
  if (stat.size > TEXT_LIMIT) return { kind: "large", bytes: stat.size };
  // Recheck after opening; O_NOFOLLOW and confinedAsync reject link escapes and hardlinks.
  const { constants } = await import("node:fs");
  const handle = await fs.open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev
    )
      throw problem(409, "文件已变化，请重试");
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > TEXT_LIMIT) return { kind: "large", bytes: size };
    return textSide(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}
function parseNames(output) {
  const fields = output.split("\0"),
    files = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    const first = fields[i++];
    files.push(
      status.startsWith("R") || status.startsWith("C")
        ? { status: status[0], originalPath: first, path: fields[i++] }
        : { status, path: first },
    );
  }
  return files;
}
async function commitInfo(root, work, version) {
  if (!/^[a-f0-9]{40}$/.test(version || ""))
    throw problem(400, "无效的历史版本");
  await gitText(root, ["merge-base", "--is-ancestor", version, "HEAD"]);
  const fields = (
    await gitText(root, [
      "show",
      "--no-patch",
      "--format=%H%x00%P%x00%s%x00%cI%x00%an",
      version,
    ])
  )
    .trimEnd()
    .split("\0");
  const parent = fields[1].split(" ")[0] || null;
  const diffArgs = parent
    ? ["diff", "--name-status", "-z", "--find-renames", parent, version]
    : [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-status",
        "-z",
        "--find-renames",
        "-r",
        version,
      ];
  const files = parseNames(
    await gitText(root, [
      ...diffArgs,
      "--",
      `projects/${work.project}/`,
      ...ROOT_FILES,
    ]),
  );
  for (const file of files) {
    try {
      validatePath(work, file.path);
      if (file.originalPath) validatePath(work, file.originalPath);
    } catch {
      file.unsafe = "该历史路径不允许在线查看";
    }
  }
  return {
    id: fields[0],
    parent,
    name: fields[2],
    created: fields[3],
    author: fields[4],
    files: files.slice(0, 500),
    total: files.length,
    truncated: files.length > 500,
  };
}

export class SourceControl {
  constructor({ db, repos, works }) {
    this.db = db;
    this.repos = repos;
    this.works = works;
  }
  async locked(work, fn) {
    // Wait only for lock acquisition. Never replay a callback that may already have written.
    for (let attempt = 0; attempt < 12; attempt++) {
      let entered = false;
      try {
        return await this.db.lock(`${work.repo}:${work.project}`, async () => {
          entered = true;
          return fn();
        });
      } catch (error) {
        if (entered || error.statusCode !== 409) throw error;
        if (attempt === 11)
          throw problem(
            409,
            "作品正在处理其他操作，请稍后重试；本次未修改文件",
          );
        await delay(Math.min(50 * (attempt + 1), 300));
      }
    }
  }
  async status(id) {
    const work = await this.works.get(id, { active: true });
    const state = await sourceSnapshot(this.repos, work);
    const remoteRef = `refs/remotes/origin/${work.branch}`;
    const remoteHead = state.repo.url
      ? await revisionOf(state.repo.root, remoteRef)
      : null;
    let ahead = 0,
      behind = 0;
    if (state.head && remoteHead)
      [ahead, behind] = (
        await gitText(state.repo.root, [
          "rev-list",
          "--left-right",
          "--count",
          `HEAD...${remoteRef}`,
        ])
      )
        .trim()
        .split(/\s+/)
        .map(Number);
    else if (state.head && state.repo.url)
      ahead = Number(
        (
          await gitText(state.repo.root, ["rev-list", "--count", "HEAD"])
        ).trim(),
      );
    const busy = await this.db.one(
      "SELECT id,kind,state FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('queued','running','cancelling','publishing','publish_failed') LIMIT 1",
      [work.repo, work.project],
    );
    return {
      revision: state.revision,
      head: state.head,
      branch: state.branch,
      expectedBranch: work.branch,
      files: state.files.slice(0, 500),
      total: state.files.length,
      truncated: state.files.length > 500,
      outside: state.outside,
      staged: state.files.filter(
        (file) => !file.untracked && file.index !== ".",
      ).length,
      unstaged: state.files.filter(
        (file) => file.untracked || file.working !== ".",
      ).length,
      conflicts: state.files.filter((file) => file.conflict).length,
      blocked:
        state.branch !== work.branch || !work.branch
          ? "检出分支与作品分支不一致"
          : state.merging
            ? "合并或变基尚未完成，请先在本地 Git 处理"
            : busy
                ? "作品任务正在执行或等待恢复，暂时只读"
                : "",
      busy: busy || null,
      sync: {
        remote: state.repo.url,
        remoteExists: !!remoteHead,
        remoteHead,
        ahead,
        behind,
        checked: work.sync_state?.checked || null,
        error: work.sync_state?.error || null,
      },
    };
  }
  async commit(id, version) {
    const work = await this.works.get(id, { active: true });
    const { repo } = await this.repos.project(work.repo, work.project, {
      exists: false,
    });
    return commitInfo(repo.root, work, version);
  }
  async diff({ id, path: file, area = "working", version }) {
    const work = await this.works.get(id, { active: true });
    validatePath(work, file);
    const state = await sourceSnapshot(this.repos, work);
    let entry, before, after, args;
    const options = [
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=4",
      "--find-renames",
    ];
    if (area === "commit") {
      const info = await commitInfo(state.repo.root, work, version);
      entry = info.files.find((item) => item.path === file);
      if (!entry) throw problem(404, "该提交中没有此文件的变化");
      before = await gitSide(
        state.repo.root,
        entry.originalPath || file,
        info.parent,
      );
      after = await gitSide(state.repo.root, file, version);
      args = info.parent
        ? ["diff", ...options, info.parent, version]
        : ["show", "--format=", ...options, version];
    } else {
      entry = state.files.find((item) => item.path === file);
      if (!entry) throw problem(404, "文件已不在变更列表中，请刷新");
      if (entry.unsafe) throw problem(400, entry.unsafe);
      if (entry.conflict) {
        const sides = await Promise.all(
          [1, 2, 3].map((stage) =>
            gitSide(state.repo.root, file, "index", stage),
          ),
        );
        await assertSourceRevision(this.repos, work, state.revision);
        return {
          path: file,
          area,
          revision: state.revision,
          conflict: true,
          base: sides[0],
          ours: sides[1],
          theirs: sides[2],
          patch: "",
        };
      }
      if (area === "staged") {
        if (entry.untracked || entry.index === ".")
          throw problem(409, "该文件没有已暂存更改");
        before = await gitSide(
          state.repo.root,
          entry.originalPath || file,
          state.head,
        );
        after = await gitSide(state.repo.root, file, "index");
        args = ["diff", "--cached", ...options];
      } else {
        if (!entry.untracked && entry.working === ".")
          throw problem(409, "该文件没有未暂存更改");
        before = entry.untracked
          ? missing()
          : await gitSide(state.repo.root, file, "index");
        after = await workingSide(state.repo.root, file);
        args = ["diff", ...options];
      }
    }
    let patch = "",
      limited = false;
    if (
      [before.kind, after.kind].every((kind) =>
        ["text", "missing"].includes(kind),
      )
    ) {
      if (entry.untracked) {
        const lines = after.text ? after.text.split("\n") : [];
        if (lines.at(-1) === "") lines.pop();
        patch = lines.length
          ? `@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((line) => "+" + line).join("\n") +
            "\n" +
            (after.text.endsWith("\n") ? "" : "\\ No newline at end of file\n")
          : "";
      } else {
        try {
          patch = await gitText(
            state.repo.root,
            [
              ...args,
              "--",
              ...new Set([
                file,
                ...(entry.originalPath ? [entry.originalPath] : []),
              ]),
            ].map((arg, index, all) =>
              index > all.indexOf("--") ? literal(arg) : arg,
            ),
            { max: 512 * 1024 },
          );
        } catch (error) {
          if (error.statusCode !== 413) throw error;
          limited = true;
        }
      }
    }
    if (area !== "commit")
      await assertSourceRevision(this.repos, work, state.revision);
    return {
      path: file,
      originalPath: entry.originalPath,
      area,
      version,
      revision: state.revision,
      before: publicSide(before),
      after: publicSide(after),
      patch,
      limited,
      binaryDiff: /^Binary files .+ differ$/m.test(patch),
    };
  }
  async change({
    id,
    action,
    paths = [],
    message,
    expectedRevision,
    confirm = false,
  }) {
    const work = await this.works.get(id, { active: true });
    return this.locked(work, async () => {
      await this.repos.writable(work.repo, work.project, { exclusive: true });
      const state = await assertSourceRevision(
        this.repos,
        work,
        expectedRevision,
      );
      safeSnapshot(work, state);
      const selected = [...new Set(paths)].map((file) => {
        validatePath(work, file);
        const entry = state.files.find((item) => item.path === file);
        if (!entry) throw problem(409, "文件已不在变更列表中，请刷新");
        if (entry.unsafe) throw problem(400, entry.unsafe);
        return entry;
      });
      const files = [
        ...new Set(
          selected.flatMap((entry) => [
            entry.path,
            ...(entry.originalPath ? [entry.originalPath] : []),
          ]),
        ),
      ];
      for (const file of files)
        await confinedAsync(state.repo.root, validatePath(work, file));
      if (!["commit", "checkpoint"].includes(action) && !files.length)
        throw problem(400, "请先选择文件");
      if (action === "stage")
        await this.repos.git(state.repo.root, [
          "add",
          "--",
          ...selected
            .flatMap((entry) => [
              entry.path,
              ...(entry.originalPath && !["R", "C"].includes(entry.index)
                ? [entry.originalPath]
                : []),
            ])
            .map(literal),
        ]);
      else if (action === "unstage") {
        if (selected.some((entry) => entry.untracked || entry.index === "."))
          throw problem(409, "所选文件没有已暂存更改");
        await this.repos.git(
          state.repo.root,
          state.head
            ? [
                "restore",
                "--staged",
                "--source=HEAD",
                "--",
                ...files.map(literal),
              ]
            : [
                "rm",
                "--cached",
                // Remove only index entries, even when working content changed.
                "--force",
                "--ignore-unmatch",
                "--",
                ...files.map(literal),
              ],
        );
      } else if (action === "discard") {
        if (!confirm || selected.length !== 1)
          throw problem(400, "撤销操作必须逐个文件确认");
        const entry = selected[0];
        if (!entry.untracked && entry.working === ".")
          throw problem(409, "没有可撤销的未暂存更改");
        await this.repos.revisions?.invalidate(work.repo, work.project);
        if (entry.untracked)
          await fs.unlink(await confinedAsync(state.repo.root, entry.path));
        else
          await this.repos.git(
            state.repo.root,
            ["restore", "--worktree", "--", literal(entry.path)],
            true,
          );
      } else if (action === "checkpoint") {
        if (!message?.trim()) throw problem(400, "请填写版本名称");
        if (!state.head || state.files.length || state.outside)
          throw problem(409, "创建命名版本前请先提交或处理所有文件更改");
        await this.repos.git(state.repo.root, [
          "-c",
          "user.name=FRAME",
          "-c",
          "user.email=frame@localhost",
          "commit",
          "--allow-empty",
          "-m",
          message.trim(),
        ]);
      } else if (action === "commit") {
        if (!message?.trim()) throw problem(400, "请填写提交说明");
        if (
          state.outsideStaged ||
          state.files.some(
            (entry) => entry.unsafe && entry.index !== "." && !entry.untracked,
          )
        )
          throw problem(
            409,
            "暂存区包含当前作品之外或不安全的文件，已阻止提交",
          );
        if (
          !state.files.some((entry) => !entry.untracked && entry.index !== ".")
        )
          throw problem(409, "没有已暂存更改；请先选择并暂存文件");
        await this.repos.git(state.repo.root, [
          "-c",
          "user.name=FRAME",
          "-c",
          "user.email=frame@localhost",
          "commit",
          "-m",
          message.trim(),
        ]);
      } else throw problem(400, "不支持的源代码管理操作");
      await this.repos.status(work.repo, { work: id });
      return this.status(id);
    });
  }
  async sync({ id, action, expectedRevision }) {
    const work = await this.works.get(id, { active: true });
    let sourceChanged = false;
    try {
      return await this.locked(work, async () => {
        if (action !== "fetch")
          await this.repos.writable(work.repo, work.project, { exclusive: true });
        const initial = await assertSourceRevision(
          this.repos,
          work,
          action === "fetch" ? null : expectedRevision,
        );
        if (!initial.repo.url)
          throw problem(400, "尚未关联远端；本地提交与历史仍可正常使用");
        if (action !== "fetch") {
          if (!expectedRevision)
            throw problem(400, "缺少状态版本，请刷新后重试");
          safeSnapshot(work, initial);
        }
        const fetched = await this.repos.status(work.repo, {
          work: id,
          fetch: true,
          prune: true,
        });
        if (fetched.error) throw problem(502, fetched.error);
        if (action === "fetch") return this.status(id);
        const state = await this.status(id);
        if (state.revision !== initial.revision)
          throw problem(409, "刷新远端期间本地内容已变化，请重新检查后同步");
        const { ahead, behind, remoteExists } = state.sync;
        if (ahead && behind)
          throw problem(
            409,
            "本地与远端已分叉，请先在本地 Git 合并；不会强制覆盖任意一侧",
          );
        if (action === "push" && behind)
          throw problem(409, "远端有新提交，请先拉取；不会强制推送");
        if (action === "pull" && !remoteExists)
          throw problem(409, "远端尚无此分支，请先发布分支");
        if ((action === "pull" || action === "sync") && behind) {
          if (initial.files.length || initial.outside)
            throw problem(
              409,
              "拉取前请先提交或处理本地更改；不会自动暂存或覆盖文件",
            );
          const target = `refs/remotes/origin/${work.branch}`;
          const remoteTree = (
            await gitText(initial.repo.root, ["ls-tree", "-rz", target])
          )
            .split("\0")
            .filter(Boolean);
          for (const record of remoteTree) {
            const tab = record.indexOf("\t"),
              [mode, type] = record.slice(0, tab).split(" ");
            validatePath(work, record.slice(tab + 1));
            if (type !== "blob" || !["100644", "100755"].includes(mode))
              throw problem(409, "远端包含链接或不支持的文件，已停止拉取");
          }
          await this.repos.git(
            initial.repo.root,
            ["lfs", "fetch", "origin", work.branch],
            true,
          );
          await this.repos.revisions?.invalidate(work.repo, work.project);
          await this.repos.git(
            initial.repo.root,
            ["merge", "--ff-only", "--no-overwrite-ignore", target],
            true,
          );
          sourceChanged = true;
          await this.repos.git(initial.repo.root, ["lfs", "checkout"]);
        }
        if (
          (action === "push" || action === "sync") &&
          (!remoteExists || ahead > 0)
        ) {
          await this.repos.git(
            initial.repo.root,
            ["lfs", "push", "origin", work.branch],
            true,
          );
          await this.repos.git(
            initial.repo.root,
            ["push", "origin", `HEAD:refs/heads/${work.branch}`],
            true,
          );
        }
        await this.repos.status(work.repo, { work: id });
        return this.status(id);
      });
    } finally {
      // Reconcile an applied fast-forward even if subsequent LFS/network work fails.
      if (sourceChanged) await this.repos.onChange?.(work.repo, work.project);
    }
  }
}
export function sourceControlOperations({ add, db, repos, works }) {
  const scm = new SourceControl({ db, repos, works });
  const id = z.string().uuid(),
    revision = z.string().regex(/^[a-f0-9]{64}$/);
  const file = z.string().min(1).max(1024);
  add(
    "works_scm_status",
    "Read scoped working/staged files and independent remote state; never fetches or writes",
    { id },
    (a) => scm.status(a.id),
  );
  add(
    "works_scm_diff",
    "Read bounded text diffs or binary/LFS metadata without changing source, index or history",
    {
      id,
      path: file,
      area: z.enum(["working", "staged", "commit"]).default("working"),
      version: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
    },
    (a) => scm.diff(a),
  );
  add(
    "works_scm_commit",
    "Read a historical commit and its changed files relative to its first parent",
    { id, version: z.string().regex(/^[a-f0-9]{40}$/) },
    (a) => scm.commit(a.id, a.version),
  );
  add(
    "works_scm_change",
    "Explicitly stage, unstage, discard one confirmed file, commit only the index, or name a clean committed version, with optimistic concurrency",
    {
      id,
      action: z.enum(["stage", "unstage", "discard", "commit", "checkpoint"]),
      paths: z.array(file).max(500).default([]),
      message: z.string().trim().max(1000).optional(),
      expectedRevision: revision,
      confirm: z.boolean().default(false),
    },
    (a) => scm.change(a),
  );
  add(
    "works_scm_sync",
    "Fetch, fast-forward pull, push committed history, or pull then push; never auto-commits or force-pushes",
    {
      id,
      action: z.enum(["fetch", "pull", "push", "sync"]),
      expectedRevision: revision.optional(),
    },
    (a) => scm.sync(a),
  );
}
