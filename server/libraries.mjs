import fs from "node:fs";
import { Lru } from "./util.mjs";

/**
 * Picking libraries among many. A repository may hold dozens or hundreds of material and
 * experience libraries; the studio's pickers and the AI tools share what is here: search
 * words, how well a library suits a work (words it shares with the work, and what works like
 * it link), how many works use each, and the names closest to one that does not exist.
 */

const KINDS = {
  materials: { name: "素材库", lister: "materials_list 的 query 按名称和介绍查找" },
  experiences: { name: "经验库", lister: "experience_list 的 query 按名称、介绍和文档标题查找" },
};

/** Search words of a query: lower case, split at spaces and punctuation. */
export const searchWords = (query) =>
  String(query || "")
    .toLowerCase()
    .split(/[\s,，、;；|/]+/)
    .filter(Boolean);

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
/** Characters too common in Chinese to mean anything as half of a word. */
const FILLER = new Set([..."的了和与及或是在这那个也都就把被让给为之其我你他她它们"]);

/**
 * Words of a text for comparing texts: Latin words and digits, and every pair of neighbouring
 * Chinese characters (Chinese has no spaces; pairs find "三维" in "三维产品展示").
 */
export function tokens(text) {
  const lower = String(text || "").toLowerCase();
  const out = new Set();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) if (word.length > 1) out.add(word);
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1 && !FILLER.has(run)) out.add(run);
    for (let index = 0; index + 1 < run.length; index++) if (!FILLER.has(run[index]) && !FILLER.has(run[index + 1])) out.add(run.slice(index, index + 2));
  }
  return out;
}

/** A name compared loosely: lower case, no spaces or punctuation, no "素材库" / "经验库" / "库" ending. */
export const looseName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/(素材库|经验库|库|library|lib)$/, "");

/** How rare each word is in a set of texts: a word every library's README has says nothing. */
function rarity(sets) {
  const counts = new Map();
  for (const set of sets) for (const word of set) counts.set(word, (counts.get(word) ?? 0) + 1);
  const total = Math.max(1, sets.length);
  return (word) => Math.log(1 + total / (counts.get(word) ?? 0.5));
}

/** Cosine of two word sets (`weights` multiplies some words of b, e.g. a title's). */
function cosine(a, b, rare, weights) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  let left = 0;
  let right = 0;
  for (const word of a) left += rare(word) ** 2;
  for (const word of b) {
    const value = rare(word) * (weights?.get(word) ?? 1);
    right += value ** 2;
    if (a.has(word)) shared += rare(word) * value;
  }
  return shared / Math.sqrt(left * right);
}

/**
 * How well a library matches search words (0: not at all): each word found in its title, id,
 * an earlier name, the introduction or other text (document titles, file names), the more
 * words the better; failing that, the Chinese word pairs it shares with the query.
 */
export function matchScore(library, query) {
  const words = searchWords(query);
  if (!words.length) return 1;
  const fields = [
    [library.title, 6],
    [library.id, 6],
    [(library.aliases ?? []).join(" "), 5],
    [library.about, 3],
    [library.extra, 2],
  ];
  let matched = 0;
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const [text, weight] of fields) if (text && String(text).toLowerCase().includes(word)) best = Math.max(best, weight);
    if (best) matched++;
    total += best;
  }
  if (matched) return matched * 100 + total;
  const wanted = tokens(query);
  const have = tokens(`${library.title} ${library.id} ${library.about ?? ""} ${library.extra ?? ""}`);
  let shared = 0;
  for (const word of wanted) if (have.has(word)) shared++;
  return shared ? Math.min(99, shared * 10) : 0;
}

/** Libraries matching a query, best first (among equals: what suits the work, then what more works use). */
export function searchLibraries(libraries, query) {
  return libraries
    .map((library) => ({ library, score: matchScore(library, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.library.score ?? 0) - (a.library.score ?? 0) ||
        (b.library.works ?? 0) - (a.library.works ?? 0) ||
        a.library.title.localeCompare(b.library.title, "zh"),
    )
    .map((item) => item.library);
}

/**
 * The series a title belongs to, as people name them: "数学：勾股定理", "Vlog | 京都",
 * "猫咪日常 第3期" → "数学", "vlog", "猫咪日常" (compared loosely); "" for none.
 */
export function seriesOf(title) {
  const text = String(title || "").trim();
  const cut = text.search(/[：:｜|·—–]|\s-\s|\s*第[一二三四五六七八九十百千\d]+[集期课话章篇节回部季]/);
  return cut >= 2 ? looseName(text.slice(0, cut)) : "";
}

/** Share of the rarer side's weight two word sets have in common (1: one holds the other). */
function overlap(a, b, rare) {
  let shared = 0;
  let left = 0;
  let right = 0;
  for (const word of a) left += rare(word);
  for (const word of b) {
    right += rare(word);
    if (a.has(word)) shared += rare(word);
  }
  return left && right ? shared / Math.min(left, right) : 0;
}

/**
 * How well each library suits a work, as `id → { score, why }`: the words its title (counted
 * double) and introduction share with the work's title, description and tags; and the
 * libraries works like it link — works of the same series, with similar titles or words, or
 * linking the same libraries.
 * `work` and `works`: { id, title, text, links: Set of "materials:<id>" / "experiences:<id>" }.
 */
export function suitability({ kind, work, libraries, works }) {
  const own = tokens(work.text);
  const shapes = libraries.map((library) => {
    const title = tokens(`${library.title} ${library.id}`);
    const words = new Set([...title, ...tokens(library.about)]);
    // What it holds (resource titles and tags, document titles): many words, so measured by how
    // much of the work's words it covers rather than by cosine, which many words would dilute.
    const content = tokens(library.extra);
    return { library, words, content, weights: new Map([...title].map((word) => [word, 2])) };
  });
  const rareInLibraries = rarity(shapes.map((shape) => new Set([...shape.words, ...shape.content])));
  let ownWeight = 0;
  for (const word of own) ownWeight += rareInLibraries(word);
  const covered = (content) => {
    let shared = 0;
    for (const word of own) if (content.has(word)) shared += rareInLibraries(word);
    return ownWeight ? shared / ownWeight : 0;
  };
  const others = works.filter((item) => item.id !== work.id).map((item) => ({ item, words: tokens(item.text), title: tokens(item.title) }));
  const ownTitle = tokens(work.title);
  const series = seriesOf(work.title);
  const rareInWorks = rarity([own, ...others.map((other) => other.words)]);
  const rareInTitles = rarity([ownTitle, ...others.map((other) => other.title)]);
  const alike = others
    .map(({ item, words, title }) => {
      const shared = [...work.links].filter((link) => item.links.has(link)).length;
      const weight = Math.max(
        series && seriesOf(item.title) === series ? 0.5 : 0,
        0.8 * overlap(ownTitle, title, rareInTitles),
        cosine(own, words, rareInWorks),
        work.links.size ? (0.8 * shared) / work.links.size : 0,
      );
      return { item, weight };
    })
    .filter((entry) => entry.weight >= 0.15)
    .sort((a, b) => b.weight - a.weight);
  const result = new Map();
  for (const { library, words, content, weights } of shapes) {
    const close = Math.max(cosine(own, words, rareInLibraries, weights), 0.8 * covered(content));
    const users = alike.filter((entry) => entry.item.links.has(`${kind}:${library.id}`));
    const peers = 1 - Math.exp(-users.reduce((sum, entry) => sum + entry.weight, 0));
    const why = [];
    if (close >= 0.12) why.push("名称、介绍或内容和作品相近");
    if (users.length) why.push(`类似的作品${users.slice(0, 2).map((entry) => `「${entry.item.title}」`).join("")}${users.length > 2 ? `等 ${users.length} 个` : ""}在用`);
    result.set(library.id, { score: Math.round((close + 0.8 * peers) * 1000) / 1000, why });
  }
  return result;
}

/** Pairs of neighbouring characters of a loose name, for names that differ a little. */
const pairsOf = (text) => {
  const out = new Set();
  for (let index = 0; index + 1 < text.length; index++) out.add(text.slice(index, index + 2));
  if (text.length === 1) out.add(text);
  return out;
};

/** Library names close to one that does not exist, closest first (at most `count`). */
export function closestLibraries(name, libraries, count = 5) {
  const wanted = looseName(name);
  if (!wanted) return [];
  const grams = pairsOf(wanted);
  return libraries
    .map((library) => {
      let best = 0;
      for (const candidate of [library.id, library.title, ...(library.aliases ?? [])]) {
        const loose = looseName(candidate);
        if (!loose) continue;
        if (loose.includes(wanted) || wanted.includes(loose)) best = Math.max(best, 0.9);
        else {
          const other = pairsOf(loose);
          let shared = 0;
          for (const gram of grams) if (other.has(gram)) shared++;
          best = Math.max(best, (2 * shared) / (grams.size + other.size));
        }
      }
      return { library, score: best };
    })
    .filter((item) => item.score >= 0.3)
    .sort((a, b) => b.score - a.score || (b.library.works ?? 0) - (a.library.works ?? 0))
    .slice(0, count)
    .map((item) => item.library);
}

/**
 * The library a name means: its folder name, an earlier name (`alias`), its title, or the
 * same written a little differently (case, spaces, punctuation, a "素材库" ending) when only
 * one library fits. Null when none does.
 */
export function findLibrary(name, libraries, alias) {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const exact = libraries.find((library) => library.id === wanted) ?? (alias ? libraries.find((library) => library.id === alias(wanted)) : null) ?? libraries.find((library) => library.title === wanted);
  if (exact) return exact;
  const loose = looseName(wanted);
  if (!loose) return null;
  const fits = libraries.filter((library) => [library.id, library.title, ...(library.aliases ?? [])].some((candidate) => looseName(candidate) === loose));
  return fits.length === 1 ? fits[0] : null;
}

/** What to say about names that lead to no library: the closest ones and how to find others. */
export function unknownLibraries(kind, names, libraries) {
  const { name, lister } = KINDS[kind];
  const close = [...new Map(names.flatMap((item) => closestLibraries(item, libraries)).map((library) => [library.id, library])).values()].slice(0, 6);
  const near = close.length ? `最接近的：${close.map((library) => `「${library.id}」${library.title !== library.id ? `（${library.title}）` : ""}`).join("")}。` : "";
  return `${name}不存在：${names.join("、")}。${near}${libraries.length ? `作品库里共有 ${libraries.length} 个${name}，用 ${lister}。` : `作品库里还没有${name}。`}新建用 create`;
}

/**
 * The lead of a library README (the first line of prose under its title), shortened; empty
 * when it is the line a new library's template wrote (it says nothing about the library).
 */
export function readmeLead(file, template = "") {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const line = (text.split("\n").find((item) => item.trim() && !item.startsWith("#")) ?? "").trim();
  if (!line || (template && line === template)) return "";
  return line.length > 160 ? line.slice(0, 159) + "…" : line;
}

/**
 * What a repository's libraries are to its works: how many works link each, when such a work
 * last changed, and how well each suits a given work. Experience links may use earlier names
 * (renamed libraries), which the experience module resolves.
 */
export class LibraryIndex {
  constructor(services) {
    this.services = services;
    this.prepared = new Lru(200); // "<repo>/<work>" → { materials, experiences }, for the (synchronous) session brief
  }

  /** The works of a repository (not in the bin) with their words and links. */
  async works(repo) {
    const catalog = await this.services.works.catalog(repo);
    const dir = this.services.experience ? await this.services.experience.dir(repo).catch(() => null) : null;
    const current = (name) => (dir ? (this.services.experience.resolve(dir, name) ?? name) : name);
    return [...catalog.values()]
      .filter((item) => !item.trashed && !item.error)
      .map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        text: [item.title, item.subtitle, item.description, ...(item.tags ?? [])].filter(Boolean).join(" "),
        links: new Set([...(item.materials ?? []).map((name) => `materials:${name}`), ...(item.experiences ?? []).map((name) => `experiences:${current(name)}`)]),
      }));
  }

  /**
   * The libraries of one kind with `works` (how many works link it) and `usedAt` (when the
   * latest of them changed); for a work also `linked`, and `score` / `why` (how well it suits
   * the work). `libraries`: [{ id, title, about?, extra? … }].
   */
  async annotate(kind, repo, libraries, work = null, works = null) {
    works ??= await this.works(repo);
    const linked = new Set(work ? this.linkedIds(kind, work) : []);
    const self = work && works.find((item) => item.id === work.id);
    const fit = work
      ? suitability({
          kind,
          work: self ?? { id: work.id, title: "", text: "", links: new Set() },
          libraries,
          works,
        })
      : null;
    return libraries.map((library) => {
      const users = works.filter((item) => item.links.has(`${kind}:${library.id}`));
      return {
        ...library,
        works: users.length,
        usedAt: users.reduce((latest, item) => (String(item.updatedAt ?? "") > latest ? String(item.updatedAt) : latest), "") || null,
        ...(work ? { linked: linked.has(library.id), ...fit.get(library.id) } : {}),
      };
    });
  }

  /** The library ids a work links now (experience links through earlier names followed). */
  linkedIds(kind, work) {
    if (kind === "materials") return this.services.materials?.names(work) ?? [];
    return this.services.experience?.linkedSync(work).libraries.map((library) => library.id) ?? [];
  }

  /** Both kinds for a work, ranked for it, kept for its session brief. */
  async prepare(work) {
    const works = await this.works(work.repo);
    const result = {
      // Material libraries with the words of what they hold (resources, sounds), when known.
      materials: this.services.materials
        ? await this.annotate("materials", work.repo, await (this.services.resources?.librariesWithWords(work.repo) ?? this.services.materials.libraries(work.repo)), work, works)
        : [],
      experiences: this.services.experience ? await this.annotate("experiences", work.repo, await this.services.experience.libraries(work.repo), work, works) : [],
    };
    // Kept for many works: without the libraries' words, which only served the ranking.
    const lean = (list) => list.map(({ extra: _extra, documents: _documents, ...library }) => library);
    this.prepared.set(`${work.repo}/${work.id}`, { materials: lean(result.materials), experiences: lean(result.experiences) });
    return result;
  }
  /** What prepare() found last time for the work (null: never prepared). */
  preparedFor(work) {
    return this.prepared.get(`${work.repo}/${work.id}`) ?? null;
  }
}

/**
 * Libraries other than the work's, in the order to offer them: the ones that suit it, then
 * the most used, then by name.
 */
export function offerOrder(libraries) {
  return [...libraries].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.works ?? 0) - (a.works ?? 0) || String(b.usedAt ?? "").localeCompare(String(a.usedAt ?? "")) || a.title.localeCompare(b.title, "zh"),
  );
}

/** Libraries that suit a work clearly enough to suggest them. */
export const SUGGEST = 0.12;

export function librariesPlugin(services) {
  services.libraries = new LibraryIndex(services);
}
