import { formatBytes } from "../lib/api";
import "./libraries.css";

/** A material or experience library as the studio lists it (see server/libraries.mjs). */
export interface LibraryInfo {
  id: string;
  title: string;
  /** The README's introduction (empty while it is the template's). */
  about?: string;
  files: number;
  size?: number;
  /** How many works link it, and when the latest of them changed. */
  works?: number;
  usedAt?: string | null;
  /** Listed for a work: whether it links the library, and how well the library suits it. */
  linked?: boolean;
  score?: number;
  why?: string[];
}
export type LibraryKind = "materials" | "experiences";
/** A library in the recycle bin: `key` names it there, `id` is the name it comes back under. */
export interface TrashedLibrary {
  key: string;
  id: string;
  title: string;
  deletedAt: string | null;
  files: number;
  size: number;
}

export const NOUN: Record<LibraryKind, string> = { materials: "素材库", experiences: "经验库" };
export type LibrarySort = "fit" | "used" | "recent" | "name";
export const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "fit", label: "适合本作品" },
  { id: "used", label: "用得最多" },
  { id: "recent", label: "最近用过" },
  { id: "name", label: "名称" },
];
export const ORDER: Record<LibrarySort, (a: LibraryInfo, b: LibraryInfo) => number> = {
  name: (a, b) => a.title.localeCompare(b.title, "zh"),
  recent: (a, b) => String(b.usedAt ?? "").localeCompare(String(a.usedAt ?? "")) || ORDER.name(a, b),
  used: (a, b) => (b.works ?? 0) - (a.works ?? 0) || ORDER.recent(a, b),
  fit: (a, b) => (b.score ?? 0) - (a.score ?? 0) || ORDER.used(a, b),
};
/** Libraries that suit a work clearly enough to offer them (as the server's SUGGEST). */
export const SUGGEST = 0.12;

export const searchWords = (query: string) =>
  query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(Boolean);
/** A name compared loosely, as the server does: no case, spaces, punctuation or "库" ending. */
export const looseName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/(素材库|经验库|库)$/, "");

/** Whether every search word is in the library's name, id or introduction. */
export function libraryMatches(library: LibraryInfo, query: string) {
  const text = [library.title, library.id, library.about ?? ""].join(" ").toLowerCase();
  return searchWords(query).every((word) => text.includes(word));
}

/** What a library row says about it: files and their size (or documents), and how many works use it. */
export function libraryFacts(kind: LibraryKind, library: Pick<LibraryInfo, "files" | "size" | "works">) {
  return [
    kind === "materials"
      ? `${library.files} 个文件${library.size ? ` · ${formatBytes(library.size)}` : ""}`
      : `${library.files} 篇`,
    library.works ? `${library.works} 个作品在用` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Text with the search words marked. */
export function Marked({ text, query }: { text: string; query: string }) {
  const wanted = searchWords(query);
  if (!wanted.length) return <>{text}</>;
  const pattern = new RegExp(`(${wanted.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part))}
    </>
  );
}
