import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Eye, Folder, FolderOpen, MessageSquarePlus, Puzzle, Sparkles, Trash2 } from "lucide-react";
import { api, del, formatBytes, skillsPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, useToast, type MenuItem } from "../lib/ui";
import type { FileEntry } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { fileIcon } from "../workbench/EditorArea";
import { buildTree, type Node } from "./ExplorerView";
import { uploadBlobs } from "./upload";

/** A skill as the server lists it (server/skills.mjs). */
export interface Skill {
  name: string;
  /** SKILL.md's name (the folder's name is what the AI and the chat's / know it by). */
  title: string;
  description: string;
  files: FileEntry[];
  /** Why the AI would not use it as it is. */
  problem?: string;
}

/** Files that are not text: shown as what they are, never opened as text. */
const BINARY =
  /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg|wav|mp3|m4a|ogg|opus|flac|aac|mp4|webm|mov|m4v|glb|gltf|fbx|obj|hdr|exr|ttf|otf|woff2?|pdf|xlsx?|docx?|pptx?|zip|gz|tgz|tar|7z|rar|bin|exe|dll|so|dylib|wasm|onnx|pt|sqlite|db)$/i;
/** A skill's documents (SKILL.md, references…): its knowledge and experience, listed with the experience libraries (server: SKILL_DOCUMENT). */
const isDocument = (path: string) => /\.(md|markdown)$/i.test(path);
/** Files a tab shows as they are (pictures, sound, video). */
const PREVIEW = /\.(png|jpe?g|webp|gif|svg|avif|wav|mp3|m4a|ogg|opus|flac|aac|weba|mp4|webm|mov|m4v)$/i;
/** A skill's file opens as a tab: as text, or shown as the picture, sound or video it is. */
export const opensHere = (path: string) => !BINARY.test(path) || PREVIEW.test(path);
/** What can be put into a work's own files as it is. */
const MEDIA = /\.(png|jpe?g|webp|gif|avif|svg|wav|mp3|m4a|ogg|opus|flac|aac|mp4|webm|mov|m4v|glb|gltf|fbx|obj|hdr|exr|ttf|otf|woff2?)$/i;

/** The repository's skills with their files, kept up to date. */
export function useSkills(repo: string) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [versioned, setVersioned] = useState(false);
  const base = skillsPath(repo);
  const load = () =>
    api<{ skills: Skill[]; versioned: boolean }>(base).then(
      (result) => {
        setSkills(result.skills);
        setVersioned(result.versioned);
      },
      () => setSkills([]),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent(
    (event) => {
      if ((event.type === "skills" && event.repo === repo) || (event.type === "work-versions" && event.work === `skills-${repo}`)) void load();
    },
    [repo],
  );
  return { skills, versioned, load };
}

/** A skill's files other than its documents (those are with the experience libraries), with the folders leading to them. */
function filesOf(files: FileEntry[]) {
  const kept = new Set(files.filter((file) => file.type === "file" && !isDocument(file.path)).map((file) => file.path));
  const folders = new Set(
    [...kept].flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  );
  return files.filter((file) => (file.type === "dir" ? folders.has(file.path) : kept.has(file.path)));
}

/**
 * The repository's skills where the material libraries are shown: each skill's files besides
 * its documents (programs, previews, data). They are the skill's own files, not copies: what is
 * deleted here is deleted in the skill, as a version of it at once, like in the 技能 view. A
 * work does not reference them as materials; a picture or video is copied into the work to use
 * it. Nothing shows without skills.
 */
export function SkillFiles() {
  const { work, readOnly, openSkill, addToChat, insertPrompt, showView } = useWorkbench();
  const { skills, load } = useSkills(work.repo);
  // Skills the user folded; folders inside them the user opened (as "+<path>").
  const [toggled, setToggled] = usePersistent<string[]>("skill-files-toggled", []);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = skillsPath(work.repo);
  const enc = encodeURIComponent;
  const shown = (skills ?? [])
    .map((skill) => ({ skill, entries: filesOf(skill.files) }))
    .filter(({ entries }) => entries.some((entry) => entry.type === "file"));
  if (!shown.length) return null;

  const flip = (key: string) => setToggled((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  const remove = (path: string, folder: boolean) =>
    run(async () => {
      if (!(await confirm(`从技能里删除${folder ? "文件夹" : ""} ${path}？可以在技能的版本历史中恢复。`, { confirm: "删除", danger: true }))) return;
      await del(`${base}/file?path=${enc(path)}`);
      await load();
    });
  const copyToWork = (path: string) =>
    run(async () => {
      const response = await fetch(`${base}/raw?path=${enc(path)}`);
      if (!response.ok) throw new Error(`读取失败（${response.status}）`);
      const [uploaded] = await uploadBlobs(work, [new File([await response.blob()], path.split("/").pop()!)]);
      toast(`已复制到作品的 ${uploaded.path}，在「本作品」里使用`, "ok");
    });

  const skillMenu = (event: React.MouseEvent, skill: Skill) => {
    const items: MenuItem[] = [];
    if (skill.files.some((file) => file.path === "SKILL.md"))
      items.push({ label: "打开 SKILL.md", icon: <Eye size={14} />, onClick: () => openSkill(`${skill.name}/SKILL.md`) });
    items.push(
      { label: "在 AI 聊天中点名使用", icon: <MessageSquarePlus size={14} />, onClick: () => insertPrompt(`@${skill.name} `) },
      { label: "在「技能」中管理…", icon: <Puzzle size={14} />, onClick: () => showView("skills") },
    );
    openMenu(event, items);
  };
  const nodeMenu = (event: React.MouseEvent, skill: Skill, node: Node) => {
    const path = `${skill.name}/${node.path}`;
    const items: MenuItem[] = [];
    if (node.type === "file" && opensHere(node.path)) items.push({ label: "打开", icon: <Eye size={14} />, onClick: () => openSkill(path) });
    items.push({ label: "引用到 AI 聊天", icon: <Sparkles size={14} />, onClick: () => addToChat({ type: "skill", path }) });
    if (node.type === "file" && MEDIA.test(node.path) && !readOnly)
      items.push({ label: "复制到作品素材", icon: <Copy size={14} />, onClick: () => copyToWork(path) });
    items.push("separator", {
      label: node.type === "dir" ? "删除文件夹" : "删除",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => remove(path, node.type === "dir"),
    });
    openMenu(event, items);
  };

  const renderNodes = (skill: Skill, nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const path = `${skill.name}/${node.path}`;
      const opened = toggled.includes("+" + path);
      const file = node.type === "file" ? skill.files.find((entry) => entry.path === node.path) : undefined;
      const openable = node.type === "dir" || opensHere(node.path);
      return (
        <div key={path}>
          <div
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            title={[
              path + (file?.size !== undefined ? ` · ${formatBytes(file.size)}` : ""),
              openable ? "" : "不能在这里打开：右键引用到 AI 聊天，或复制到作品素材",
            ]
              .filter(Boolean)
              .join("\n")}
            onClick={() => (node.type === "dir" ? flip("+" + path) : openable && openSkill(path, { preview: true }))}
            onDoubleClick={() => node.type === "file" && openable && openSkill(path)}
            onContextMenu={(event) => nodeMenu(event, skill, node)}
          >
            {node.type === "dir" ? (
              <>
                {opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {opened ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />}
              </>
            ) : (
              <>
                <span style={{ width: 14 }} />
                {fileIcon(node.path)}
              </>
            )}
            <span className={`ellipsis grow ${openable ? "" : "faint"}`}>{node.name}</span>
            {file?.size !== undefined && <span className="faint small-text">{formatBytes(file.size)}</span>}
          </div>
          {node.type === "dir" && opened && renderNodes(skill, node.children, depth + 1)}
        </div>
      );
    });

  return (
    <>
      {busy && <div className="view-progress" />}
      <div
        className="library-group"
        title="作品库里技能自带的文件（程序、预览、数据等；技能的文档在「经验库」里），就是技能里的文件，不是副本。图片、视频要用到作品里时，右键「复制到作品素材」。"
      >
        技能里的素材 <span className="count">{shown.length}</span>
        <span className="grow" />
        <button className="link-btn" title="在「技能」中上传、下载或删除技能" onClick={() => showView("skills")}>
          <Puzzle size={13} /> 技能…
        </button>
      </div>
      <div className="tree">
        {shown.map(({ skill, entries }) => {
          const folded = toggled.includes(skill.name);
          const count = entries.filter((entry) => entry.type === "file").length;
          return (
            <div key={skill.name}>
              <div
                className="tree-row skill-row"
                style={{ paddingLeft: 8 }}
                title={`技能 @${skill.name}${skill.description ? `\n${skill.description}` : ""}\n${count} 个文件，就是技能里的文件，不是副本`}
                onClick={() => flip(skill.name)}
                onContextMenu={(event) => skillMenu(event, skill)}
              >
                {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Puzzle size={14} className="folder-icon" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">{skill.name}</div>
                  {skill.description && <div className="faint small-text skill-description">{skill.description}</div>}
                </div>
                <span className="faint small-text">{count} 个</span>
              </div>
              {!folded && renderNodes(skill, buildTree(entries), 1)}
            </div>
          );
        })}
      </div>
      {menu}
    </>
  );
}
