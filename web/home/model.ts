import type { Repo, WorkSummary } from "../lib/types";

/** What the home page shows: a list of works, the recycle bin or the settings. */
export type Scope =
  | { kind: "all" }
  | { kind: "recent" }
  | { kind: "attention" }
  | { kind: "repo"; repo: string }
  | { kind: "trash"; repo?: string }
  | { kind: "settings"; section?: string };

/** Remembered between visits (the bin and the settings are passing visits). */
export const scopeKey = (scope: Scope) => (scope.kind === "repo" ? `repo:${scope.repo}` : scope.kind);
export function parseScope(key: string, repos: Repo[]): Scope {
  if (key.startsWith("repo:")) {
    const repo = key.slice(5);
    return repos.some((item) => item.id === repo) ? { kind: "repo", repo } : { kind: "all" };
  }
  return key === "recent" || key === "attention" ? { kind: key } : { kind: "all" };
}

/** Where a work is in its life: the user marks 草稿, 编辑中 and 废案; publishing makes it 已发布. */
export type WorkState = "draft" | "editing" | "published" | "abandoned";
export const STATE_LABELS: Record<WorkState, string> = { draft: "草稿", editing: "编辑中", published: "已发布", abandoned: "废案" };
export const stateOf = (work: Pick<WorkSummary, "publishedAt" | "status">): WorkState => (work.publishedAt ? "published" : work.status || "editing");
/** The value the server takes for a state the user can mark. */
export const STATUS_VALUES: Record<Exclude<WorkState, "published">, WorkSummary["status"]> = { draft: "draft", editing: "", abandoned: "abandoned" };

export type Filter = "all" | WorkState | "cloud";
export const FILTERS: { id: Filter; label: string; test: (work: WorkSummary) => boolean }[] = [
  { id: "all", label: "全部", test: () => true },
  ...(["draft", "editing", "published", "abandoned"] as const).map((state) => ({
    id: state,
    label: STATE_LABELS[state],
    test: (work: WorkSummary) => stateOf(work) === state,
  })),
  { id: "cloud", label: "仅 GitHub", test: (work) => work.location === "remote" },
];

export type Sort = "updated" | "opened" | "title" | "duration";
export const SORTS: { id: Sort; label: string }[] = [
  { id: "updated", label: "最近修改" },
  { id: "opened", label: "最近打开" },
  { id: "title", label: "名称" },
  { id: "duration", label: "时长" },
];
const collator = new Intl.Collator("zh-CN", { numeric: true });
export function sortWorks(list: WorkSummary[], sort: Sort) {
  const byDate = (a = "", b = "") => b.localeCompare(a);
  const compare: Record<Sort, (a: WorkSummary, b: WorkSummary) => number> = {
    updated: (a, b) => byDate(a.updatedAt, b.updatedAt),
    opened: (a, b) => byDate(a.openedAt, b.openedAt) || byDate(a.updatedAt, b.updatedAt),
    title: (a, b) => collator.compare(a.title, b.title),
    duration: (a, b) => b.duration - a.duration || collator.compare(a.title, b.title),
  };
  return [...list].sort(compare[sort]);
}

export function matches(work: WorkSummary, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [work.title, work.subtitle, work.description, work.id, ...(work.tags ?? [])].join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

export const workKey = (work: Pick<WorkSummary, "repo" | "id">) => `${work.repo}/${work.id}`;

/** Both this machine and GitHub have new versions: the user decides in the work. */
export const conflicted = (work: WorkSummary) => work.location === "both" && Boolean(work.remoteNewer) && !work.synced;

/** Works waiting for the user: an AI asked to delete them, they conflict with GitHub, or cannot be read. */
export const needsAttention = (work: WorkSummary) => Boolean(work.deleteRequest) || Boolean(work.error) || conflicted(work);

/** How a work's picture is shaped: a common name ("16:9") or else its size. */
export function ratioLabel(width: number, height: number) {
  if (!width || !height) return "";
  const ratio = width / height;
  const known: [number, string][] = [
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
    [1, "1:1"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [4 / 5, "4:5"],
    [21 / 9, "21:9"],
    [64 / 27, "21:9"],
  ];
  return known.find(([value]) => Math.abs(value - ratio) / value < 0.01)?.[1] ?? `${width}×${height}`;
}

export function formatDuration(seconds: number) {
  if (!seconds) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The repository's page on GitHub (https or ssh address), or "" when it is not on GitHub. */
export function githubPage(remote: string) {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  return match ? `https://github.com/${match[1]}` : "";
}

/** "owner/name" split, so the owner can be shown quieter. */
export function repoName(repo: Repo) {
  const slash = repo.name.lastIndexOf("/");
  return slash > 0 ? { owner: repo.name.slice(0, slash + 1), name: repo.name.slice(slash + 1) } : { owner: "", name: repo.name };
}
