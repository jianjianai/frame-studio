import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, MessageSquarePlus, MessageSquareText, Pencil, Send, Trash2 } from "lucide-react";
import { Dialog, useConfirm, useContextMenu, usePersistent, usePrompt, useToast } from "../lib/ui";
import { findPrompt, insertPrompt, movePrompt, newPromptId, removePrompt, updatePrompt, usePrompts, type PromptNode } from "../lib/prompts";
import { useWorkbench } from "../workbench/store";
import { ViewHeader } from "./ViewHeader";

/** Name and text of a prompt, new or existing. */
export function PromptDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: { name: string; text: string };
  onSave: (value: { name: string; text: string }) => void | Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const valid = name.trim() && text.trim();
  const save = async () => {
    if (!valid) return;
    await onSave({ name: name.trim(), text });
    onClose();
  };
  return (
    <Dialog
      title={initial.name ? "编辑提示词" : "新建提示词"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span>名称</span>
        <input className="input" autoFocus={!initial.name} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：检查并修复" />
      </label>
      <label className="field">
        <span>内容（点击提示词时放进 AI 输入框）</span>
        <textarea
          className="textarea"
          rows={10}
          autoFocus={Boolean(initial.name)}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => (event.ctrlKey || event.metaKey) && event.key === "Enter" && void save()}
        />
      </label>
    </Dialog>
  );
}

const firstLine = (text: string) => text.trim().split("\n")[0];

/**
 * The prompt library, organized like bookmarks: folders, drag to reorder or move,
 * right-click to edit. Clicking a prompt puts it into the AI chat's input box.
 */
export function PromptsView() {
  const { insertPrompt: insertIntoChat } = useWorkbench();
  const [items, save] = usePrompts();
  const [closed, setClosed] = usePersistent<string[]>("prompt-folders-closed", []);
  const [editing, setEditing] = useState<{ id?: string; folder: string | null; name: string; text: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string | null; mode: "into" | "before" } | null>(null);
  const [openMenu, menu] = useContextMenu();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const list = items ?? [];
  const commit = (next: PromptNode[]) => save(next).catch((error) => toast((error as Error).message, "error"));

  const newFolder = async (parent: string | null) => {
    const name = (await prompt("新文件夹", "", "例如：开场、配音、检查"))?.trim();
    if (!name) return;
    void commit(insertPrompt(list, { id: newPromptId(), type: "folder", name, children: [] }, parent));
    if (parent) setClosed(closed.filter((id) => id !== parent));
  };
  const rename = async (node: PromptNode) => {
    const name = (await prompt(node.type === "folder" ? "重命名文件夹" : "重命名提示词", node.name))?.trim();
    if (name && name !== node.name) void commit(updatePrompt(list, node.id, { name }));
  };
  const remove = async (node: PromptNode) => {
    const what = node.type === "folder" ? `文件夹「${node.name}」和其中的 ${countPrompts(node.children)} 个提示词` : `提示词「${node.name}」`;
    if (await confirm(`删除${what}？`, { confirm: "删除", danger: true })) void commit(removePrompt(list, node.id));
  };
  const folderOf = (node: PromptNode) => (node.type === "folder" ? node.id : (findPrompt(list, node.id)?.parent?.id ?? null));

  const menuFor = (event: React.MouseEvent, node: PromptNode) =>
    openMenu(event, [
      ...(node.type === "prompt"
        ? [
            { label: "放进输入框", icon: <Send size={14} />, onClick: () => insertIntoChat(node.text) },
            { label: "编辑", icon: <Pencil size={14} />, onClick: () => setEditing({ id: node.id, folder: null, name: node.name, text: node.text }) },
          ]
        : []),
      { label: "新建提示词", icon: <MessageSquarePlus size={14} />, onClick: () => setEditing({ folder: folderOf(node), name: "", text: "" }) },
      { label: "新建文件夹", icon: <FolderPlus size={14} />, onClick: () => newFolder(folderOf(node)) },
      "separator",
      { label: "重命名", icon: <Pencil size={14} />, onClick: () => rename(node) },
      { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(node) },
    ]);

  const drop = (folder: string | null, before?: string) => {
    if (dragging) void commit(movePrompt(list, dragging, folder, before));
    setDragging(null);
    setTarget(null);
  };

  const rows = (nodes: PromptNode[], depth: number, folder: string | null): React.ReactNode =>
    nodes.map((node) => {
      const open = node.type === "folder" && !closed.includes(node.id);
      const highlight = target?.id === node.id ? `drop-${target.mode}` : "";
      return (
        <div key={node.id}>
          <div
            className={`tree-row prompt-row ${highlight} ${dragging === node.id ? "dragging" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={node.type === "prompt" ? node.text.slice(0, 400) : node.name}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", node.type === "prompt" ? node.text : node.name);
              setDragging(node.id);
            }}
            onDragEnd={() => {
              setDragging(null);
              setTarget(null);
            }}
            onDragOver={(event) => {
              if (!dragging || dragging === node.id) return;
              event.preventDefault();
              event.stopPropagation();
              // Upper half of a row: before it; a folder's lower half: into it.
              const rect = event.currentTarget.getBoundingClientRect();
              const mode = node.type === "folder" && event.clientY > rect.top + rect.height / 2 ? "into" : "before";
              if (target?.id !== node.id || target.mode !== mode) setTarget({ id: node.id, mode });
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (target?.mode === "into") drop(node.id);
              else drop(folder, node.id);
            }}
            onClick={() =>
              node.type === "folder"
                ? setClosed(open ? [...closed, node.id] : closed.filter((id) => id !== node.id))
                : insertIntoChat(node.text)
            }
            onDoubleClick={() => node.type === "prompt" && setEditing({ id: node.id, folder: null, name: node.name, text: node.text })}
            onContextMenu={(event) => menuFor(event, node)}
          >
            {node.type === "folder" ? (
              <>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />}
                <span className="ellipsis grow">{node.name}</span>
                <span className="faint small-text">{countPrompts(node.children)}</span>
              </>
            ) : (
              <>
                <span style={{ width: 14, flex: "none" }} />
                <MessageSquareText size={14} />
                <span className="ellipsis grow">
                  {node.name}
                  <span className="faint prompt-preview"> {firstLine(node.text)}</span>
                </span>
              </>
            )}
          </div>
          {node.type === "folder" && open && rows(node.children, depth + 1, node.id)}
        </div>
      );
    });

  return (
    <div className="view">
      <ViewHeader title="提示词">
        <button className="icon-btn" title="新建提示词" onClick={() => setEditing({ folder: null, name: "", text: "" })}>
          <MessageSquarePlus size={15} />
        </button>
        <button className="icon-btn" title="新建文件夹" onClick={() => newFolder(null)}>
          <FolderPlus size={15} />
        </button>
      </ViewHeader>
      <p className="view-hint">点击提示词放进 AI 输入框。拖动可以排序或移进文件夹，右键编辑。所有作品共用。</p>
      <div
        className={`tree prompt-tree ${target?.id === null ? "drop-end" : ""}`}
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          if (target?.id !== null) setTarget({ id: null, mode: "before" });
        }}
        onDrop={(event) => {
          event.preventDefault();
          drop(null);
        }}
      >
        {items && !list.length && <div className="empty small-text">还没有提示词</div>}
        {rows(list, 0, null)}
      </div>
      {editing && (
        <PromptDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={({ name, text }) =>
            commit(
              editing.id
                ? updatePrompt(list, editing.id, { name, text })
                : insertPrompt(list, { id: newPromptId(), type: "prompt", name, text }, editing.folder),
            )
          }
        />
      )}
      {menu}
    </div>
  );
}

export const countPrompts = (nodes: PromptNode[]): number =>
  nodes.reduce((sum, node) => sum + (node.type === "folder" ? countPrompts(node.children) : 1), 0);
