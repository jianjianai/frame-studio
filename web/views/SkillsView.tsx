import { useEffect, useState } from "react";
import { zipSync } from "fflate";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus,
  FileText,
  FolderUp,
  GitBranch,
  MessageSquarePlus,
  Puzzle,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { api, ApiError, del, skillsPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, useToast, type MenuItem } from "../lib/ui";
import type { FileEntry } from "../lib/types";
import { RemoteBar } from "../workbench/RemoteBar";
import { useWorkbench } from "../workbench/store";
import { buildTree, type Node } from "./ExplorerView";
import { ViewHeader } from "./ViewHeader";

/** A skill as the server lists it (server/skills.mjs). */
interface Skill {
  name: string;
  /** SKILL.md's name (the folder's name is what the AI and the chat's / know it by). */
  title: string;
  description: string;
  files: FileEntry[];
  /** Why the AI would not use it as it is. */
  problem?: string;
}

/** Files that are not text: listed, not opened. */
const BINARY =
  /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg|wav|mp3|m4a|ogg|opus|flac|aac|mp4|webm|mov|glb|gltf|fbx|obj|hdr|exr|ttf|otf|woff2?|pdf|xlsx?|docx?|pptx?|zip|gz|tgz|tar|7z|rar|bin|exe|dll|so|dylib|wasm|onnx|pt|sqlite|db)$/i;
const ACCEPT = ".zip,.skill,.md";
const WRITE_PROMPT = "请把我们这次的做法整理成这个作品库的一个技能（.claude/skills/<名称>/SKILL.md），名称和说明你来定；动手前先告诉我打算怎么写。";

/** Files picked or dropped as one upload: an archive or SKILL.md as it is, a folder zipped here. */
async function packFolder(files: { path: string; file: File }[]) {
  const entries: Record<string, Uint8Array> = {};
  for (const { path, file } of files) entries[path] = new Uint8Array(await file.arrayBuffer());
  const top = files[0]?.path.split("/")[0] || "skills";
  return new File([zipSync(entries, { level: 6 })], `${top}.zip`, { type: "application/zip" });
}

/** The files of dropped folders (and loose files), with their paths. */
async function droppedFiles(items: DataTransferItemList) {
  const out: { path: string; file: File }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands out at most 100 entries a call.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...items].map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
  for (const entry of entries) await walk(entry, "");
  return { files: out, folders: entries.some((entry) => entry.isDirectory) };
}

/**
 * The AI skills of the work's repository (a folder with SKILL.md each), shared by all its works
 * and seen by no other repository: upload (a folder, a .zip / .skill archive or one SKILL.md),
 * create, open their files as editor tabs, download, delete. Every change is a version at once
 * (版本与同步 → 技能).
 */
export function SkillsView() {
  const { work, openSkill, insertPrompt, showVersions } = useWorkbench();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [versioned, setVersioned] = useState(false);
  const [open, setOpen] = usePersistent<string[]>("skills-open", []);
  const [dropping, setDropping] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = skillsPath(work.repo);
  const enc = encodeURIComponent;

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
  useServerEvent((event) => {
    if (event.type === "skills" && event.repo === work.repo) void load();
    if (event.type === "work-versions" && event.work === `skills-${work.repo}`) void load();
  });

  const upload = (file: File) =>
    run(async () => {
      const send = (replace: boolean) =>
        api<{ skills: Skill[] }>(`${base}/upload?name=${enc(file.name)}${replace ? "&replace=1" : ""}`, {
          raw: file,
          contentType: file.type || "application/octet-stream",
        });
      let result: { skills: Skill[] };
      try {
        result = await send(false);
      } catch (error) {
        const existing = error instanceof ApiError && error.status === 409 ? (error.details as { existing?: string[] } | undefined)?.existing : undefined;
        if (!existing) throw error;
        if (!(await confirm(`已经有技能「${existing.join("」「")}」。用上传的替换吗？原来的可以在版本历史中恢复。`, { confirm: "替换" }))) return;
        result = await send(true);
      }
      await load();
      const names = result.skills.map((skill) => skill.name);
      setOpen((current) => [...new Set([...current, ...names])]);
      toast(`已上传技能：${names.join("、")}`, "ok");
    });
  const pick = (folder: boolean) => {
    const input = document.createElement("input");
    input.type = "file";
    if (folder) input.webkitdirectory = true;
    else input.accept = ACCEPT;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      void upload(folder ? await packFolder(files.map((file) => ({ path: file.webkitRelativePath || file.name, file }))) : files[0]);
    };
    input.click();
  };
  const drop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const loose = [...event.dataTransfer.files];
    let { files, folders } = await droppedFiles(event.dataTransfer.items);
    // Without folder entries (some browsers), the files as they come.
    if (!files.length) files = loose.map((file) => ({ path: file.name, file }));
    if (!files.length) return;
    if (!folders && files.length === 1) return upload(files[0].file);
    return upload(await packFolder(files));
  };
  const create = () =>
    run(async () => {
      const name = (await prompt("新技能的名称（文件夹名：文字、数字、点、下划线或连字符，不能有空格）", ""))?.trim();
      if (!name) return;
      const skill = await api<Skill>(`${base}/create`, { body: { name } });
      await load();
      setOpen((current) => [...new Set([...current, skill.name])]);
      openSkill(`${skill.name}/SKILL.md`, { edit: true });
    });
  const download = (name: string) => {
    const link = document.createElement("a");
    link.href = `${base}/download?name=${enc(name)}`;
    link.download = `${name}.zip`;
    link.click();
  };
  const removeSkill = (name: string) =>
    run(async () => {
      if (!(await confirm(`删除技能「${name}」？这个作品库的所有作品都不能再用它；可以在版本历史中恢复。`, { confirm: "删除", danger: true }))) return;
      await del(`${base}/skill?name=${enc(name)}`);
      await load();
    });
  const removeFile = (file: string) =>
    run(async () => {
      if (!(await confirm(`删除 ${file}？可以在版本历史中恢复。`, { confirm: "删除", danger: true }))) return;
      await del(`${base}/file?path=${enc(file)}`);
      await load();
    });

  const flip = (key: string) => setOpen((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  const editable = (file: FileEntry) => file.type === "file" && !BINARY.test(file.path);
  const skillMenu = (event: React.MouseEvent, skill: Skill) =>
    openMenu(event, [
      {
        label: "打开 SKILL.md",
        icon: <FileText size={14} />,
        onClick: () => openSkill(`${skill.name}/SKILL.md`),
        disabled: !skill.files.some((file) => file.path === "SKILL.md"),
      },
      { label: "在 AI 聊天中使用", icon: <MessageSquarePlus size={14} />, onClick: () => insertPrompt(`/${skill.name} `) },
      { label: "下载", icon: <Download size={14} />, onClick: () => download(skill.name) },
      "separator",
      { label: "删除技能", icon: <Trash2 size={14} />, danger: true, onClick: () => removeSkill(skill.name) },
    ]);
  const fileMenu = (event: React.MouseEvent, skill: Skill, node: Node) => {
    const path = `${skill.name}/${node.path}`;
    const items: MenuItem[] = [];
    if (node.type === "file" && editable({ path: node.path, type: "file" }))
      items.push({ label: "打开", icon: <FileText size={14} />, onClick: () => openSkill(path) });
    if (node.path !== "SKILL.md")
      items.push({ label: node.type === "dir" ? "删除文件夹" : "删除文件", icon: <Trash2 size={14} />, danger: true, onClick: () => removeFile(path) });
    if (items.length) openMenu(event, items);
  };
  const renderFiles = (skill: Skill, nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const key = `${skill.name}/${node.path}`;
      const text = node.type === "file" && editable({ path: node.path, type: "file" });
      return (
        <div key={key}>
          <div
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 12, cursor: node.type === "dir" || text ? "pointer" : "default" }}
            title={text || node.type === "dir" ? key : `${key}（不是文本，下载技能后查看）`}
            onClick={() => (node.type === "dir" ? flip(key) : text && openSkill(key, { preview: true }))}
            onDoubleClick={() => text && openSkill(key)}
            onContextMenu={(event) => fileMenu(event, skill, node)}
          >
            {node.type === "dir" ? (
              open.includes(key) ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : (
              <>
                <span style={{ width: 14 }} />
                <FileText size={14} />
              </>
            )}
            <span className={`ellipsis grow ${text || node.type === "dir" ? "" : "faint"}`}>{node.name}</span>
          </div>
          {node.type === "dir" && open.includes(key) && renderFiles(skill, node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div
      className={`view library-panel ${dropping ? "drop-target" : ""}`}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as globalThis.Node | null) && setDropping(false)}
      onDrop={(event) => void drop(event)}
    >
      <ViewHeader title="技能">
        <button className="icon-btn" title="新建技能" onClick={create}>
          <FilePlus size={15} />
        </button>
        <button className="icon-btn" title="上传技能文件夹" onClick={() => pick(true)}>
          <FolderUp size={15} />
        </button>
        <button className="icon-btn" title="上传 .zip / .skill 压缩包或 SKILL.md" onClick={() => pick(false)}>
          <Upload size={15} />
        </button>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      {busy && <div className="view-progress" />}
      {versioned && <RemoteBar base={`${base}/remote`} repo={work.repo} scope={`skills-${work.repo}`} what="技能" onSettled={() => void load()} />}
      <p className="view-hint">
        这个作品库的 AI 技能，库里的所有作品共用，其他作品库看不到。AI 按每个技能的说明自己决定什么时候用，也可以在聊天里输入 / 和技能名直接调用。
      </p>
      <div className="tree">
        {(skills ?? []).map((skill) => (
          <div key={skill.name}>
            <div
              className="tree-row skill-row"
              style={{ paddingLeft: 8 }}
              title={`/${skill.name}${skill.title !== skill.name ? `（SKILL.md 里叫 ${skill.title}）` : ""}\n${skill.description}${skill.problem ? `\n⚠ ${skill.problem}` : ""}`}
              onClick={() => flip(skill.name)}
              onContextMenu={(event) => skillMenu(event, skill)}
            >
              {open.includes(skill.name) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Puzzle size={14} className="folder-icon" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{skill.name}</div>
                {skill.description && <div className="faint small-text skill-description">{skill.description}</div>}
              </div>
              {skill.problem && <AlertTriangle size={14} className="warn-text" aria-label={skill.problem} />}
            </div>
            {open.includes(skill.name) && renderFiles(skill, buildTree(skill.files), 1)}
          </div>
        ))}
      </div>
      <section className="view-section">
        {skills && !skills.length && (
          <p className="view-hint">
            还没有技能。技能是一个文件夹，入口是其中的 SKILL.md（开头写 name 和 description，AI 靠 description
            判断什么时候用），参考文档、脚本等放在同一个文件夹里。可以上传文件夹、.zip / .skill 压缩包或单独一个 SKILL.md，也可以拖到这里。
          </p>
        )}
        <div className="row">
          <button className="btn small grow" onClick={() => pick(true)}>
            <FolderUp size={13} /> 上传文件夹
          </button>
          <button className="btn small grow" onClick={() => pick(false)}>
            <Upload size={13} /> 上传压缩包
          </button>
        </div>
        <div className="row">
          <button className="btn small grow" title="把这次的做法整理成技能（先放进输入框，可以改了再发）" onClick={() => insertPrompt(WRITE_PROMPT)}>
            <Sparkles size={13} /> 让 AI 写一个技能
          </button>
        </div>
        {versioned && (
          <button className="link-btn" onClick={() => showVersions("skills")}>
            <GitBranch size={12} /> 技能的版本历史
          </button>
        )}
      </section>
      {menu}
    </div>
  );
}
