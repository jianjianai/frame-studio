import fs from "node:fs";
import path from "node:path";
import { tree } from "../files.mjs";
import { sha256 } from "../util.mjs";
import { formatTime } from "../render.mjs";

/**
 * What the AI knows, and what it is told each turn.
 *
 * A session starts with a brief (the work-root AGENTS.md, which Claude Code imports
 * through CLAUDE.md and Codex reads directly): platform rules, the work's own notes and
 * the linked experience library. Both agents load it at session start and keep it through
 * context compaction. Afterwards each message carries only what changed since: the
 * player and selection, files others changed, experience documents others edited.
 *
 * Budgets are in UTF-8 bytes: Codex reads at most 32 KiB of AGENTS.md, and Chinese text
 * takes three bytes per character.
 */
export const LIMITS = {
  notes: 6000, // the work's own AGENTS.md
  inlineLibrary: 12000, // a library this small is put into the brief in full
  readme: 6000, // otherwise its README, plus an index of the other documents
  index: 3000,
  changedDocument: 4000, // a changed document this small is shown again in full
  changedTotal: 8000,
  changedFiles: 12,
};

const bytes = (text) => Buffer.byteLength(text, "utf8");
/** Cut text to a byte budget without splitting a character. */
export function clip(text, budget) {
  if (bytes(text) <= budget) return { text, cut: false };
  let out = "";
  let used = 0;
  for (const char of text) {
    used += bytes(char);
    if (used > budget) break;
    out += char;
  }
  return { text: out, cut: true };
}

/**
 * A document embedded verbatim, in a fence longer than any backtick run inside it: the
 * brief keeps its own structure, and the text stays byte-identical to the file so the AI
 * can copy it straight into an exact-match edit.
 */
export function quote(content) {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}markdown\n${content.replace(/\n+$/, "")}\n${fence}`;
}

// ---- experience libraries -------------------------------------------------------------

/** Title (first "# " heading) and one-line summary (first paragraph line) of a document. */
export function describeDocument(file, content) {
  // Lines inside fenced code are neither headings nor prose.
  let fenced = false;
  const lines = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(line);
  }
  const title =
    lines
      .find((line) => /^#\s+/.test(line))
      ?.replace(/^#\s+/, "")
      .trim() || path.basename(file).replace(/\.(md|txt)$/i, "");
  const first = lines.find((line) => line && !line.startsWith("#") && !/^[-*>|]+$/.test(line)) ?? "";
  const summary = first.replace(/^([-*>]|\d+\.)\s+/, "").replace(/[*_`]/g, "");
  return { title, summary: summary.length > 80 ? summary.slice(0, 79) + "…" : summary };
}

/** The Markdown documents of a library folder, README first. */
export function readLibrary(root) {
  const documents = tree(root)
    .filter((entry) => entry.type === "file" && /\.(md|txt)$/i.test(entry.path))
    .map((entry) => {
      const content = fs.readFileSync(path.join(root, entry.path), "utf8");
      return { path: entry.path, content, hash: sha256(content), bytes: bytes(content), chars: content.length, ...describeDocument(entry.path, content) };
    });
  return documents.sort((a, b) => (a.path === "README.md" ? -1 : b.path === "README.md" ? 1 : a.path.localeCompare(b.path, "zh")));
}

const indexLine = (doc) => `- \`${doc.path}\` ${doc.title}${doc.summary && doc.summary !== doc.title ? "：" + doc.summary : ""}（约 ${doc.chars} 字）`;

/**
 * One library as a brief shows it: in full when it fits `inline` bytes, else its README plus
 * an index of the other documents. `docs` is what the AI knows afterwards: per document its
 * hash and whether it has the content or only the index line.
 */
export function libraryBrief(library, documents, { inline = LIMITS.inlineLibrary, readme: readmeBudget = LIMITS.readme, index: indexBudget = LIMITS.index } = {}) {
  const total = documents.reduce((sum, doc) => sum + doc.bytes, 0);
  const full = total <= inline;
  const docs = {};
  const parts = [];
  if (full) {
    for (const doc of documents) {
      parts.push(`### ${doc.path}\n\n${quote(doc.content)}`);
      docs[doc.path] = { hash: doc.hash, level: "content" };
    }
  } else {
    const readme = documents.find((doc) => doc.path === "README.md");
    if (readme) {
      const { text, cut } = clip(readme.content, readmeBudget);
      parts.push(`### README.md${cut ? "（开头部分，完整内容用 experience_read 阅读）" : ""}\n\n${quote(text)}`);
      docs[readme.path] = { hash: readme.hash, level: cut ? "index" : "content" };
    }
    const others = documents.filter((doc) => doc.path !== "README.md");
    if (others.length) {
      const lines = [];
      let used = 0;
      for (const doc of others) {
        const line = indexLine(doc);
        if (used + bytes(line) > indexBudget) {
          lines.push(`- ……还有 ${others.length - lines.length} 篇，用 experience_read 查看完整目录`);
          break;
        }
        used += bytes(line);
        lines.push(line);
      }
      parts.push(`### 其他文档（与当前任务相关时用 experience_read 阅读全文）\n\n${lines.join("\n")}`);
    }
    for (const doc of others) docs[doc.path] = { hash: doc.hash, level: "index" };
  }
  return { library, text: parts.join("\n\n"), docs, full, bytes: total };
}

/**
 * The libraries a work links, for a brief: in the work's order, each in full while the
 * inline budget lasts, the others as README plus index (those budgets shared, so the
 * whole brief stays under Codex's 32 KiB). `seen` maps library id → { title, docs }.
 * `libraries`: [{ library: {id, title}, documents }].
 */
export function experienceBrief(libraries) {
  let inline = LIMITS.inlineLibrary;
  const share = Math.max(1, libraries.length);
  const seen = {};
  const sections = [];
  for (const { library, documents } of libraries) {
    const brief = libraryBrief(library, documents, { inline, readme: Math.floor(LIMITS.readme / share), index: Math.floor(LIMITS.index / share) });
    if (brief.full) inline -= brief.bytes;
    seen[library.id] = { title: library.title, docs: brief.docs };
    sections.push(brief);
  }
  return { sections, seen };
}

/** Brief sections as text, one "## 经验库「标题」" per library. */
export function briefText(sections) {
  return sections
    .map(({ library, text, full }) => `## 经验库「${library.title}」\n\n${full ? "全部文档如下。" : "首页和其他文档的目录如下。"}\n\n${text}`)
    .join("\n\n");
}

/**
 * What to tell the AI about its experience libraries before a message: nothing when it
 * already knows the current state; a library new to the session in full (or README and
 * index); a library no longer linked; otherwise the documents others added, changed or
 * deleted (small ones in full). `seen`: { [library id]: { title, docs } };
 * `current`: [{ library: {id, title}, documents }] in the work's order.
 */
export function experienceDelta(seen, current) {
  const before = seen ?? {};
  const next = {};
  const parts = [];
  for (const [id, entry] of Object.entries(before))
    if (!current.some((item) => item.library.id === id)) parts.push(`作品不再关联经验库「${entry.title}」，之前读到的那些经验不再适用于这个作品。`);
  const added = current.filter((item) => !before[item.library.id]);
  if (added.length) {
    const brief = experienceBrief(added);
    Object.assign(next, brief.seen);
    parts.push(`作品现在关联了${added.map((item) => `经验库「${item.library.title}」`).join("、")}，动手前对照，照着做：\n\n${briefText(brief.sections)}`);
  }
  for (const item of current) {
    if (!before[item.library.id]) continue;
    const delta = libraryDelta(before[item.library.id], item);
    next[item.library.id] = delta.seen;
    if (delta.text) parts.push(delta.text);
  }
  return { text: parts.join("\n\n"), seen: next };
}

/** Documents of one known library that others added, changed or deleted. */
function libraryDelta(known, { library, documents }) {
  const items = [];
  const sections = [];
  const docs = {};
  let budget = LIMITS.changedTotal;
  for (const doc of documents) {
    const before = known.docs[doc.path];
    if (before && before.hash === doc.hash) {
      docs[doc.path] = before;
      continue;
    }
    // New documents, and changed ones whose old content the AI has, are worth showing in full.
    if ((!before || before.level === "content") && doc.bytes <= LIMITS.changedDocument && doc.bytes <= budget) {
      budget -= doc.bytes;
      sections.push(`### ${doc.path}（${before ? "已更新" : "新增"}，最新内容）\n\n${quote(doc.content)}`);
      docs[doc.path] = { hash: doc.hash, level: "content" };
      continue;
    }
    if (!before) items.push(`- 新增 ${indexLine(doc).slice(2)}`);
    else if (before.level === "content") items.push(`- \`${doc.path}\` 已修改，你之前读到的内容已过时，用到时用 experience_read 重新阅读`);
    else items.push(`- \`${doc.path}\` 已修改（${doc.title}${doc.summary ? "：" + doc.summary : ""}）`);
    docs[doc.path] = { hash: doc.hash, level: "index" };
  }
  for (const file of Object.keys(known.docs)) if (!documents.some((doc) => doc.path === file)) items.push(`- \`${file}\` 已删除`);
  const seen = { title: library.title, docs };
  if (!items.length && !sections.length) return { text: "", seen };
  return { text: [`经验库「${library.title}」有变化（来自用户或其他对话，不是你改的）：`, ...items, ...sections].join("\n"), seen };
}

/**
 * Experience documents the user referenced ({ library, path }; library may be left out when
 * the work links one) that the AI only knows by title, in full when small.
 */
export function referencedExperience(seen, current, refs) {
  const sections = [];
  for (const ref of refs) {
    const item = ref.library ? current.find((entry) => entry.library.id === ref.library) : current.length === 1 ? current[0] : null;
    const doc = item?.documents.find((entry) => entry.path === ref.path);
    if (!doc || !seen?.[item.library.id] || seen[item.library.id].docs[doc.path]?.level === "content" || doc.bytes > LIMITS.changedDocument) continue;
    sections.push(`### ${doc.path}（用户引用的经验库「${item.library.title}」文档）\n\n${quote(doc.content)}`);
    seen = noteSeen(seen, item.library.id, doc.path, doc.hash, "content");
  }
  return { text: sections.join("\n\n"), seen };
}

/**
 * After a resume the agent reloads the brief, but its conversation still holds what it
 * read before: keep content it read unless the brief now carries that document anyway.
 */
export function rebaseSeen(previous, baseline) {
  const next = {};
  for (const [id, entry] of Object.entries(baseline ?? {})) {
    const old = previous?.[id];
    const docs = { ...entry.docs };
    if (old?.docs)
      for (const [file, doc] of Object.entries(old.docs)) if (doc.level === "content" && docs[file] && docs[file].level !== "content") docs[file] = doc;
    next[id] = { ...entry, docs };
  }
  return next;
}

/** Record what the AI read or wrote itself, so it is not told about it again. */
export function noteSeen(seen, library, file, hash, level = "content") {
  const entry = seen?.[library];
  if (!entry) return seen;
  const docs = { ...entry.docs };
  if (hash === null) delete docs[file];
  else if (!(level === "index" && docs[file]?.level === "content" && docs[file].hash === hash)) docs[file] = { hash, level };
  return { ...seen, [library]: { ...entry, docs } };
}

// ---- the work's files ------------------------------------------------------------------

/** Cheap fingerprint of the work's files (size and modification time). */
export function snapshotFiles(dir) {
  const files = {};
  for (const entry of tree(dir)) if (entry.type === "file") files[entry.path] = `${entry.size}:${Math.round(entry.mtime)}`;
  return files;
}

/** Files that changed between two snapshots, as a notice for the AI ("" when none). */
export function filesNotice(before, after) {
  if (!before) return "";
  const changed = [],
    added = [],
    removed = [];
  for (const [file, stamp] of Object.entries(after)) {
    if (!(file in before)) added.push(file);
    else if (before[file] !== stamp) changed.push(file);
  }
  for (const file of Object.keys(before)) if (!(file in after)) removed.push(file);
  const total = changed.length + added.length + removed.length;
  if (!total) return "";
  let shown = 0;
  const group = (label, list) => {
    if (!list.length || shown >= LIMITS.changedFiles) return null;
    const names = list.slice(0, LIMITS.changedFiles - shown);
    shown += names.length;
    return `${label} ${names.join("、")}`;
  };
  const parts = [group("修改", changed), group("新增", added), group("删除", removed)].filter(Boolean);
  const more = total > shown ? ` 等 ${total} 个文件` : "";
  return `上一轮之后，用户（或其他对话）改动了作品文件：${parts.join("；")}${more}。改这些文件前先读取最新内容，不要用你记忆中的旧内容覆盖用户的修改。`;
}

// ---- what the user is looking at -----------------------------------------------------------

const seconds = (value) => `${formatTime(value)}`;

/** The timeline object the user selected, described for the AI. */
export function selectionText(selection, meta) {
  if (!selection || !meta) return "";
  if (selection.kind === "layer") {
    const clip = meta.visual?.clips?.find((item) => item.id === selection.id);
    return clip ? `图层 ${clip.id}${clip.name ? "「" + clip.name + "」" : ""}（${seconds(clip.start)}–${seconds(clip.start + clip.duration)}）` : "";
  }
  const audio = meta.audioDocument;
  if (selection.kind === "audio") {
    const clip = audio?.clips?.find((item) => item.id === selection.id);
    if (!clip) return "";
    const track = audio.tracks?.find((item) => item.id === clip.track);
    return `音频片段 ${clip.id}${clip.name ? "「" + clip.name + "」" : ""}（音轨「${track?.name ?? clip.track}」，${seconds(clip.start)}–${seconds(clip.start + clip.duration)}）`;
  }
  if (selection.kind === "track") {
    const track = audio?.tracks?.find((item) => item.id === selection.id);
    return track ? `音轨「${track.name}」（${track.id}）` : "";
  }
  if (selection.kind === "subtitle") {
    const cue = meta.subtitles?.[selection.index];
    return cue ? `字幕「${cue.text}」（${seconds(cue.start)}–${seconds(cue.end)}）` : "";
  }
  if (selection.kind === "beat") {
    const beat = meta.beats?.[selection.index];
    return beat ? `镜头标记「${beat.title}」（${seconds(beat.at)}）` : "";
  }
  return "";
}
