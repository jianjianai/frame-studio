import { useCallback, useEffect, useState } from "react";
import { api, put, useServerEvent } from "./api";

export interface PromptItem {
  id: string;
  type: "prompt";
  name: string;
  text: string;
}
export interface PromptFolder {
  id: string;
  type: "folder";
  name: string;
  children: PromptNode[];
}
export type PromptNode = PromptItem | PromptFolder;

// crypto.randomUUID needs a secure context, which a studio opened over plain LAN http is not.
export const newPromptId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** The prompt library (shared by all works), kept in sync across views and browser tabs. */
export function usePrompts() {
  const [items, setItems] = useState<PromptNode[] | null>(null);
  const load = useCallback(() => api<PromptNode[]>("/api/prompts").then(setItems, () => {}), []);
  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent((event) => {
    if (event.type === "settings" && event.key === "prompts") void load();
  });
  const save = useCallback(
    async (next: PromptNode[]) => {
      setItems(next);
      try {
        setItems(await put<PromptNode[]>("/api/prompts", { items: next }));
      } catch (error) {
        void load();
        throw error;
      }
    },
    [load],
  );
  return [items, save] as const;
}

/** The node, the folder holding it (null at the top level) and its position there. */
export function findPrompt(list: PromptNode[], id: string, parent: PromptFolder | null = null): { node: PromptNode; parent: PromptFolder | null; index: number } | null {
  for (const [index, node] of list.entries()) {
    if (node.id === id) return { node, parent, index };
    if (node.type === "folder") {
      const found = findPrompt(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

const mapTree = (list: PromptNode[], change: (list: PromptNode[], parent: string | null) => PromptNode[], parent: string | null = null): PromptNode[] =>
  change(list, parent).map((node) => (node.type === "folder" ? { ...node, children: mapTree(node.children, change, node.id) } : node));

export const updatePrompt = (list: PromptNode[], id: string, change: Partial<PromptNode>) =>
  mapTree(list, (items) => items.map((node) => (node.id === id ? ({ ...node, ...change } as PromptNode) : node)));

export const removePrompt = (list: PromptNode[], id: string) => mapTree(list, (items) => items.filter((node) => node.id !== id));

/** Insert into a folder (null: the top level) before `before` (an id), or at the end. */
export function insertPrompt(list: PromptNode[], node: PromptNode, folder: string | null, before?: string): PromptNode[] {
  const place = (items: PromptNode[]) => {
    const index = before ? items.findIndex((item) => item.id === before) : -1;
    return index < 0 ? [...items, node] : [...items.slice(0, index), node, ...items.slice(index)];
  };
  return folder === null ? place(list) : mapTree(list, (items, parent) => (parent === folder ? place(items) : items));
}

/** Whether `id` is the node itself or inside it (a folder cannot move into itself). */
export const holds = (node: PromptNode, id: string): boolean => node.id === id || (node.type === "folder" && node.children.some((child) => holds(child, id)));

export function movePrompt(list: PromptNode[], id: string, folder: string | null, before?: string): PromptNode[] {
  const found = findPrompt(list, id);
  if (!found || (folder && holds(found.node, folder)) || before === id) return list;
  return insertPrompt(removePrompt(list, id), found.node, folder, before);
}
