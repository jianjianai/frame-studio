import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import type { WorkInfo } from "../lib/types";

/** The documents a timeline edit can touch: visual.json, audio.json, or project.ts (subtitles, shot markers). */
export type TimelineDoc = "layers" | "audio" | "project";
interface Step {
  doc: TimelineDoc;
  label: string;
  before: unknown;
  after: unknown;
}

const LIMIT = 100;
// What the server writes for a work's first audio edit; "no audio.json yet" undoes to this.
const EMPTY_AUDIO = { schemaVersion: 1, sources: [], tracks: [], clips: [], buses: [], master: { gain: 1, processors: [] }, linkedVideo: true };

/** Key-order independent JSON, so a re-read document compares equal to the one we wrote. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);

/**
 * Undo/redo for manual timeline edits. Each edit records the edited document before
 * and after; undo writes the "before" back. When the document changed in between
 * (the AI or another window edited it), undo refuses instead of overwriting that work.
 */
export type TimelineHistory = ReturnType<typeof useTimelineHistory>;

export function useTimelineHistory(base: string, reload: () => Promise<void>) {
  const past = useRef<Step[]>([]);
  const future = useRef<Step[]>([]);
  const [, setVersion] = useState(0);
  const changed = () => setVersion((value) => value + 1);

  const read = useCallback(
    async (doc: TimelineDoc) => {
      if (doc === "project") {
        const info = await api<WorkInfo>(base);
        const meta = info.meta;
        // The project.ts fields the timeline and the properties view edit.
        return {
          value: {
            subtitles: meta?.subtitles ?? [],
            beats: meta?.beats ?? [],
            duration: meta?.duration,
            fps: meta?.fps,
            title: meta?.title,
            description: meta?.description,
          },
          sha: null,
        };
      }
      const result = await api<{ document: unknown; sha256: string | null }>(`${base}/${doc === "layers" ? "layers" : "audio"}`);
      return { value: doc === "audio" ? (result.document ?? EMPTY_AUDIO) : result.document, sha: result.sha256 };
    },
    [base],
  );
  const write = useCallback(
    (doc: TimelineDoc, value: unknown, sha: string | null) =>
      doc === "project"
        ? api(base, { method: "PATCH", body: value })
        : api(`${base}/${doc}`, { body: { operations: [{ op: "replace", document: value }], expectedSha256: sha ?? undefined } }),
    [base],
  );

  /** Run an edit of one document and record it. */
  const run = useCallback(
    async (doc: TimelineDoc, label: string, mutate: () => Promise<unknown>) => {
      const before = (await read(doc)).value;
      await mutate();
      const after = (await read(doc)).value;
      if (canonical(before) !== canonical(after)) {
        past.current = [...past.current.slice(-(LIMIT - 1)), { doc, label, before, after }];
        future.current = [];
        changed();
      }
      await reload();
    },
    [read, reload],
  );

  const move = useCallback(
    async (direction: "undo" | "redo") => {
      const from = direction === "undo" ? past : future;
      const to = direction === "undo" ? future : past;
      const step = from.current.at(-1);
      if (!step) return null;
      const current = await read(step.doc);
      const expected = direction === "undo" ? step.after : step.before;
      if (canonical(current.value) !== canonical(expected)) {
        past.current = [];
        future.current = [];
        changed();
        throw new Error("时间轴之后被 AI 或其他操作修改过，无法撤销。撤销记录已清空。");
      }
      await write(step.doc, direction === "undo" ? step.before : step.after, current.sha);
      from.current = from.current.slice(0, -1);
      to.current = [...to.current, step];
      changed();
      await reload();
      return step.label;
    },
    [read, write, reload],
  );

  return {
    run,
    undo: () => move("undo"),
    redo: () => move("redo"),
    undoLabel: past.current.at(-1)?.label ?? null,
    redoLabel: future.current.at(-1)?.label ?? null,
  };
}
