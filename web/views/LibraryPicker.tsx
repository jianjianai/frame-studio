import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpDown, Plus, Search, Sparkles, X } from "lucide-react";
import { Dialog, useAction, usePersistent } from "../lib/ui";
import { Marked, NOUN, ORDER, SORTS, libraryFacts, libraryMatches, looseName, type LibraryInfo, type LibraryKind, type LibrarySort } from "./libraryShared";

/** Rows drawn at once; typing narrows the rest down. */
const SHOWN = 300;

/**
 * Picking one library among many (e.g. where to put a file): search by name and introduction,
 * sorted by fit, use, recent use or name; `pinned` ones stay on top. A name nothing matches can
 * be created.
 */
export function LibraryPicker({
  kind,
  libraries,
  pinned: pinnedIds = [],
  title,
  hint,
  onApply,
  onCreate,
  onClose,
}: {
  kind: LibraryKind;
  libraries: LibraryInfo[];
  /** Ids kept on top (the work's libraries). */
  pinned?: string[];
  title: string;
  hint?: ReactNode;
  onApply: (ids: string[]) => Promise<unknown> | unknown;
  /** Create a library with the typed name; returns it. */
  onCreate?: (name: string) => Promise<LibraryInfo | undefined>;
  onClose: () => void;
}) {
  const noun = NOUN[kind];
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePersistent<LibrarySort>("library-sort", "fit");
  const [active, setActive] = useState(0);
  const [run] = useAction();
  const listRef = useRef<HTMLDivElement>(null);
  const [pinned] = useState(() => new Set(pinnedIds));
  const suits = libraries.some((library) => (library.score ?? 0) > 0);
  const order = ORDER[sort === "fit" && !suits ? "used" : sort];
  const matched = useMemo(
    () => libraries.filter((library) => libraryMatches(library, query)).sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || order(a, b)),
    [libraries, query, order, pinned],
  );
  const typed = query.trim();
  const canCreate = Boolean(onCreate && typed && !libraries.some((library) => [library.id, library.title, ...(library.aliases ?? [])].some((name) => looseName(name) === looseName(typed))));
  // Rows the keyboard moves through: "create" first when offered, then the libraries.
  const rows: (LibraryInfo | "create")[] = [...(canCreate ? ["create" as const] : []), ...matched.slice(0, SHOWN)];

  const pick = (id: string) =>
    run(async () => {
      await onApply([id]);
      onClose();
    });
  const create = () =>
    run(async () => {
      const library = await onCreate?.(typed);
      if (!library) return;
      await onApply([library.id]);
      onClose();
    });
  const choose = (row: LibraryInfo | "create" | undefined) => (row === "create" ? create() : row && pick(row.id));
  const move = (to: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="library-picker-note grow">{canCreate ? "回车新建；" : ""}单击选择一个{noun}</span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <div className="library-picker">
        <div className="library-picker-bar">
          <label className="library-search">
            <Search size={14} />
            <input
              autoFocus
              placeholder={`搜索${noun}的名称或介绍${onCreate ? "，或输入新名称" : ""}`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") (event.preventDefault(), move(active + 1));
                else if (event.key === "ArrowUp") (event.preventDefault(), move(active - 1));
                else if (event.key === "Enter") (event.preventDefault(), choose(rows[active]));
              }}
            />
            {query && (
              <button className="icon-btn" aria-label="清除搜索" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <label className="library-sort" title="排序">
            <ArrowUpDown size={13} />
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
              {SORTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {hint && <p className="library-picker-hint">{hint}</p>}
        <div className="library-options" role="listbox" ref={listRef}>
          {rows.map((row, index) =>
            row === "create" ? (
              <div key="create" data-row={index} className={`library-option create ${index === active ? "active" : ""}`} onMouseMove={() => setActive(index)} onClick={create}>
                <Plus size={15} />
                <span>
                  新建{noun}「{typed}」
                </span>
              </div>
            ) : (
              <div
                key={row.id}
                data-row={index}
                role="option"
                aria-selected={index === active}
                className={`library-option ${index === active ? "active" : ""}`}
                onMouseMove={() => setActive(index)}
                onClick={() => pick(row.id)}
                title={row.id !== row.title ? `文件夹：${row.id}` : undefined}
              >
                <div className="library-option-main">
                  <div className="library-option-head">
                    <strong className="ellipsis">
                      <Marked text={row.title} query={query} />
                    </strong>
                    {row.linked && <span className="badge accent">本作品</span>}
                    <span className="grow" />
                    <span className="faint small-text">{libraryFacts(kind, row)}</span>
                  </div>
                  {row.about && (
                    <div className="library-option-about ellipsis">
                      <Marked text={row.about} query={query} />
                    </div>
                  )}
                  {!row.linked && row.why?.length ? (
                    <div className="library-option-why ellipsis">
                      <Sparkles size={11} /> {row.why.join("；")}
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          )}
          {matched.length > SHOWN && <p className="library-picker-hint">还有 {matched.length - SHOWN} 个，输入关键词缩小范围。</p>}
          {!rows.length && <p className="library-picker-hint">{libraries.length ? `没有符合的${noun}。` : `还没有${noun}${onCreate ? "，输入名称新建一个" : ""}。`}</p>}
        </div>
      </div>
    </Dialog>
  );
}
