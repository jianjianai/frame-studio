import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpDown, Plus, Search, Sparkles, X } from "lucide-react";
import { formatBytes } from "../lib/api";
import { Dialog, useAction, usePersistent } from "../lib/ui";
import "./libraries.css";

/** A material or experience library as the studio lists it (see server/libraries.mjs). */
export interface LibraryInfo {
  id: string;
  title: string;
  /** The README's introduction (empty while it is the template's). */
  about?: string;
  files: number;
  size?: number;
  /** Earlier names (experience libraries that were renamed). */
  aliases?: string[];
  /** How many works link it, and when the latest of them changed. */
  works?: number;
  usedAt?: string | null;
  /** Listed for a work: whether it links the library, and how well the library suits it. */
  linked?: boolean;
  score?: number;
  why?: string[];
}
export type LibraryKind = "materials" | "experiences";

const NOUN: Record<LibraryKind, string> = { materials: "素材库", experiences: "经验库" };
type Sort = "fit" | "used" | "recent" | "name";
const SORTS: { id: Sort; label: string }[] = [
  { id: "fit", label: "适合本作品" },
  { id: "used", label: "用得最多" },
  { id: "recent", label: "最近用过" },
  { id: "name", label: "名称" },
];
/** Rows drawn at once; typing narrows the rest down. */
const SHOWN = 300;

const words = (query: string) =>
  query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(Boolean);
/** A name compared loosely, as the server does: no case, spaces, punctuation or "库" ending. */
const loose = (name: string) =>
  name
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/(素材库|经验库|库)$/, "");

/** Whether every search word is in the library's name, folder, earlier names or introduction. */
export function libraryMatches(library: LibraryInfo, query: string) {
  const text = [library.title, library.id, ...(library.aliases ?? []), library.about ?? ""].join(" ").toLowerCase();
  return words(query).every((word) => text.includes(word));
}

/** What a library row says about it: files and their size (or documents), and how many works use it. */
export function libraryFacts(kind: LibraryKind, library: LibraryInfo) {
  return [
    kind === "materials" ? `${library.files} 个文件${library.size ? ` · ${formatBytes(library.size)}` : ""}` : `${library.files} 篇`,
    library.works ? `${library.works} 个作品在用` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const ORDER: Record<Sort, (a: LibraryInfo, b: LibraryInfo) => number> = {
  name: (a, b) => a.title.localeCompare(b.title, "zh"),
  recent: (a, b) => String(b.usedAt ?? "").localeCompare(String(a.usedAt ?? "")) || ORDER.name(a, b),
  used: (a, b) => (b.works ?? 0) - (a.works ?? 0) || ORDER.recent(a, b),
  fit: (a, b) => (b.score ?? 0) - (a.score ?? 0) || ORDER.used(a, b),
};

/** Text with the search words marked. */
export function Marked({ text, query }: { text: string; query: string }) {
  const wanted = words(query);
  if (!wanted.length) return <>{text}</>;
  const pattern = new RegExp(`(${wanted.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part))}</>;
}

/** Libraries that suit a work clearly enough to offer them (as the server's SUGGEST). */
const SUGGEST = 0.12;

/** Up to three libraries that suit the work, each a click away from being used. */
export function LibrarySuggestions({ libraries, onUse, disabled }: { libraries: LibraryInfo[]; onUse: (id: string) => void; disabled?: boolean }) {
  const list = libraries
    .filter((library) => !library.linked && (library.score ?? 0) >= SUGGEST)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 3);
  if (!list.length) return null;
  return (
    <div className="library-suggestions">
      <div className="library-suggestions-title">
        <Sparkles size={12} /> 可能适合这个作品
      </div>
      {list.map((library) => (
        <div key={library.id} className="library-suggestion" title={library.about || undefined}>
          <div className="grow">
            <div className="ellipsis">{library.title}</div>
            <div className="library-option-why ellipsis">{library.why?.join("；")}</div>
          </div>
          <button className="btn small" disabled={disabled} onClick={() => onUse(library.id)}>
            使用
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Choosing libraries among many: search by name and introduction, sorted by how well they suit
 * the work (with why), how many works use them, when they were last used, or by name; several
 * at once (applied together) or `single` (pick one). A name nothing matches can be created.
 */
export function LibraryPicker({
  kind,
  libraries,
  initial = [],
  pinned: pinnedIds,
  single = false,
  title,
  confirm = "确定",
  hint,
  onApply,
  onCreate,
  onClose,
}: {
  kind: LibraryKind;
  libraries: LibraryInfo[];
  /** Ids chosen when it opens (the work's libraries): they stay on top while it is open. */
  initial?: string[];
  /** Ids kept on top instead of `initial`'s (picking one: the work's libraries). */
  pinned?: string[];
  single?: boolean;
  title: string;
  confirm?: string;
  hint?: ReactNode;
  onApply: (ids: string[]) => Promise<unknown> | unknown;
  /** Create a library with the typed name; returns it. */
  onCreate?: (name: string) => Promise<LibraryInfo | undefined>;
  onClose: () => void;
}) {
  const noun = NOUN[kind];
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePersistent<Sort>("library-sort", "fit");
  const [chosen, setChosen] = useState<string[]>(initial);
  const [created, setCreated] = useState<LibraryInfo[]>([]);
  const [active, setActive] = useState(0);
  const [run, busy] = useAction();
  const listRef = useRef<HTMLDivElement>(null);
  const [pinned] = useState(() => new Set(pinnedIds ?? initial));
  // Libraries made here show up in `libraries` too once the panel has reloaded.
  const all = useMemo(() => [...libraries, ...created.filter((item) => !libraries.some((library) => library.id === item.id))], [libraries, created]);
  const suits = all.some((library) => (library.score ?? 0) > 0);
  const order = ORDER[sort === "fit" && !suits ? "used" : sort];
  const matched = useMemo(
    () => all.filter((library) => libraryMatches(library, query)).sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || order(a, b)),
    [all, query, order, pinned],
  );
  const typed = query.trim();
  const canCreate = Boolean(
    onCreate && typed && !all.some((library) => [library.id, library.title, ...(library.aliases ?? [])].some((name) => loose(name) === loose(typed))),
  );
  // Rows the keyboard moves through: "create" first when offered, then the libraries.
  const rows: (LibraryInfo | "create")[] = [...(canCreate ? ["create" as const] : []), ...matched.slice(0, SHOWN)];
  const byId = new Map(all.map((library) => [library.id, library]));

  const apply = (ids: string[]) =>
    run(async () => {
      await onApply(ids);
      onClose();
    });
  const toggle = (id: string) => {
    if (single) return void apply([id]);
    setChosen((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  };
  const create = () =>
    run(async () => {
      const library = await onCreate?.(typed);
      if (!library) return;
      setCreated((list) => [...list, library]);
      setQuery("");
      setActive(0);
      if (single) {
        await onApply([library.id]);
        onClose();
      } else setChosen((list) => [...list, library.id]);
    });
  const choose = (row: LibraryInfo | "create" | undefined) => (row === "create" ? create() : row && toggle(row.id));
  const move = (to: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const changed = chosen.length !== initial.length || chosen.some((id, index) => id !== initial[index]);

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="library-picker-note grow">
            {canCreate ? "回车新建；" : ""}
            {single ? `单击选择一个${noun}` : `已选 ${chosen.length} 个 · 回车勾选，Ctrl+回车确定`}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {!single && (
            <button className="btn primary" disabled={busy || !changed} onClick={() => apply(chosen)}>
              {confirm}
            </button>
          )}
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
                else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !single) (event.preventDefault(), changed && apply(chosen));
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
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              {SORTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {hint && <p className="library-picker-hint">{hint}</p>}
        {!single && chosen.length > 0 && (
          <div className="library-chips" aria-label="已选">
            {chosen.map((id) => (
              <span key={id} className="library-chip">
                <span className="ellipsis">{byId.get(id)?.title ?? id}</span>
                <button className="icon-btn" aria-label={`不选「${byId.get(id)?.title ?? id}」`} onClick={() => toggle(id)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="library-options" role="listbox" aria-multiselectable={!single} ref={listRef}>
          {rows.map((row, index) =>
            row === "create" ? (
              <div
                key="create"
                data-row={index}
                className={`library-option create ${index === active ? "active" : ""}`}
                onMouseMove={() => setActive(index)}
                onClick={create}
              >
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
                aria-selected={chosen.includes(row.id)}
                className={`library-option ${index === active ? "active" : ""} ${chosen.includes(row.id) ? "selected" : ""}`}
                onMouseMove={() => setActive(index)}
                onClick={() => toggle(row.id)}
                title={row.id !== row.title ? `文件夹：${row.id}` : undefined}
              >
                {!single && <input type="checkbox" checked={chosen.includes(row.id)} readOnly tabIndex={-1} />}
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
          {!rows.length && (
            <p className="library-picker-hint">{all.length ? `没有符合的${noun}。` : `还没有${noun}${onCreate ? "，输入名称新建一个" : ""}。`}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
