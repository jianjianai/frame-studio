import fs from "node:fs";
import path from "node:path";
import { tree } from "../files.mjs";
import { sha256 } from "../util.mjs";
import { formatTime } from "../render.mjs";

/**
 * What the AI knows, and what it is told each turn.
 *
 * A session starts with a brief (the work-root AGENTS.md, which Claude Code imports
 * through CLAUDE.md and Codex reads directly): the platform's basic rules and where things
 * are — the work's own notes, its 经验.md, the linked experience libraries — which the AI
 * reads itself as it needs them. Afterwards each message carries only what changed since:
 * the player and selection, files others changed, experience documents others edited.
 */
export const LIMITS = {
  referenced: 4000, // an experience document the user attached this small comes along in full
  changedFiles: 12,
};

const bytes = (text) => Buffer.byteLength(text, "utf8");
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

/**
 * The sections of a Markdown document: each heading below the title (## and deeper, outside
 * fenced code) with its text up to the next heading of the same or a higher level.
 */
export function documentSections(content) {
  const lines = content.split("\n");
  const heads = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) fenced = !fenced;
    const match = !fenced && /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) heads.push({ index, level: match[1].length, title: match[2].trim() });
  });
  return heads.map((head, at) => {
    const next = heads.slice(at + 1).find((item) => item.level <= head.level);
    const text = lines
      .slice(head.index, next ? next.index : lines.length)
      .join("\n")
      .replace(/\n+$/, "");
    return { title: head.title, level: head.level, text, chars: text.length };
  });
}

/** A section by its heading: the one titled so, else the only one whose title contains it; null when none. */
export function findSection(content, title) {
  const sections = documentSections(content);
  const wanted = title.trim().replace(/^#+\s*/, "");
  const exact = sections.find((section) => section.title === wanted);
  if (exact) return exact;
  const loose = sections.filter((section) => section.title.toLowerCase().includes(wanted.toLowerCase()));
  return loose.length === 1 ? loose[0] : null;
}

/** The Markdown documents of a library folder (`only`: which files count), README first. */
export function readLibrary(root, only = /\.(md|txt)$/i) {
  const documents = tree(root)
    .filter((entry) => entry.type === "file" && only.test(entry.path))
    .map((entry) => {
      const content = fs.readFileSync(path.join(root, entry.path), "utf8");
      return { path: entry.path, content, hash: sha256(content), bytes: bytes(content), chars: content.length, ...describeDocument(entry.path, content) };
    });
  return documents.sort((a, b) => (a.path === "README.md" ? -1 : b.path === "README.md" ? 1 : a.path.localeCompare(b.path, "zh")));
}

const indexLine = (doc) => `- \`${doc.path}\` ${doc.title}${doc.summary && doc.summary !== doc.title ? "：" + doc.summary : ""}（约 ${doc.chars} 字）`;

/** What the AI knows of its libraries when a session starts: each document by name and version, none read yet. */
export function experienceKnown(libraries) {
  const seen = {};
  for (const { library, documents } of libraries)
    seen[library.id] = { title: library.title, docs: Object.fromEntries(documents.map((doc) => [doc.path, { hash: doc.hash, level: "index" }])) };
  return seen;
}

/** A document in a library's overview: its index line, and its sections when it has several (readable on their own). */
const overviewLine = (doc) => {
  const sections = documentSections(doc.content).filter((section) => section.level === 2);
  return indexLine(doc) + (sections.length > 1 ? `\n  小节：${sections.map((section) => `${section.title}（${section.chars} 字）`).join("、")}` : "");
};

/**
 * A library as experience_read shows it without a path: its README (a skill's SKILL.md) in full,
 * unless the AI has it already (`known`, unchanged since it read it), and the list of its documents.
 */
export function libraryOverview(library, documents, { known } = {}) {
  const readme = documents.find((doc) => doc.path === "README.md") ?? documents.find((doc) => doc.path === "SKILL.md");
  const others = documents.filter((doc) => doc !== readme);
  const readmeKnown = readme && known?.[readme.path]?.read && known[readme.path].hash === readme.hash;
  return [
    `## 经验库「${library.title}」（id ${library.id}）`,
    readme ? `### ${readme.path}\n\n${readmeKnown ? "（这个对话里已经读过，之后没有改动）" : quote(readme.content)}` : "",
    others.length ? `### 文档\n\n${others.map(overviewLine).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What to tell the AI about its experience libraries before a message: nothing when nothing
 * changed; libraries linked or unlinked since; documents others added, changed or deleted
 * (by name: the AI reads what it needs). `seen`: { [library id]: { title, docs } };
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
    Object.assign(next, experienceKnown(added));
    parts.push(`作品现在关联了${added.map((item) => `经验库「${item.library.title}」（id ${item.library.id}）`).join("、")}，需要时用 experience_read 读。`);
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
  const docs = {};
  for (const doc of documents) {
    const before = known.docs[doc.path];
    if (before && before.hash === doc.hash) {
      docs[doc.path] = before;
      continue;
    }
    if (!before) items.push(`- 新增 ${indexLine(doc).slice(2)}`);
    else if (before.level === "content" || before.sections?.length) items.push(`- \`${doc.path}\` 已修改，你之前读到的内容已过时`);
    else items.push(`- \`${doc.path}\` 已修改`);
    docs[doc.path] = { hash: doc.hash, level: "index" };
  }
  for (const file of Object.keys(known.docs)) if (!documents.some((doc) => doc.path === file)) items.push(`- \`${file}\` 已删除`);
  const seen = { title: library.title, docs };
  if (!items.length) return { text: "", seen };
  return { text: [`经验库「${library.title}」有变化（来自用户或其他对话，不是你改的）：`, ...items].join("\n"), seen };
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
    if (!doc || !seen?.[item.library.id] || seen[item.library.id].docs[doc.path]?.level === "content" || doc.bytes > LIMITS.referenced) continue;
    sections.push(`### ${doc.path}（用户引用的经验库「${item.library.title}」文档）\n\n${quote(doc.content)}`);
    seen = noteSeen(seen, item.library.id, doc.path, doc.hash, "content");
  }
  return { text: sections.join("\n\n"), seen };
}

/**
 * After a resume the agent reloads the brief, but its conversation still holds what it
 * read before: keep what it read.
 */
export function rebaseSeen(previous, baseline) {
  const next = {};
  for (const [id, entry] of Object.entries(baseline ?? {})) {
    const old = previous?.[id];
    const docs = { ...entry.docs };
    if (old?.docs)
      for (const [file, doc] of Object.entries(old.docs))
        if ((doc.level === "content" || doc.sections?.length) && docs[file] && docs[file].level !== "content") docs[file] = doc;
    next[id] = { ...entry, docs };
  }
  return next;
}

/**
 * Record what the AI read or wrote itself, so it is not told about it again. Level "read" is the
 * whole document read through experience_read (its text is in the AI's context), "section" one
 * section of it (`section`, its title); what the AI wrote ("content") it knows by its own edits.
 */
export function noteSeen(seen, library, file, hash, level = "content", section = null) {
  const entry = seen?.[library];
  if (!entry) return seen;
  const docs = { ...entry.docs };
  const same = docs[file]?.hash === hash ? docs[file] : null;
  if (hash === null) delete docs[file];
  else if (level === "section") {
    if (!same?.read) docs[file] = { hash, level: same?.level ?? "index", sections: [...new Set([...(same?.sections ?? []), section])] };
  } else if (level === "read") docs[file] = { hash, level: "content", read: true };
  else if (level !== "index" || !(same?.level === "content" || same?.sections)) docs[file] = { hash, level };
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
