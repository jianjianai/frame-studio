import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import { Puzzle } from "lucide-react";
import { api, skillsPath, useServerEvent } from "../lib/api";

/** A skill of the work's repository (server/skills.mjs). */
export interface SkillChoice {
  name: string;
  description: string;
  problem?: string;
}

/** The skills of a repository, kept up to date. */
export function useRepoSkills(repo: string) {
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  const load = () =>
    api<{ skills: SkillChoice[] }>(skillsPath(repo)).then(
      (result) => setSkills(result.skills),
      () => {},
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);
  useServerEvent(
    (event) => {
      if ((event.type === "skills" && event.repo === repo) || (event.type === "work-versions" && event.work === `skills-${repo}`)) void load();
    },
    [repo],
  );
  return skills;
}

/**
 * What is being typed just before the caret: a /<command or skill> at the start of the message
 * (also put in front of text written before), or an @<skill> anywhere (at the start or after a
 * space). `start` is where its / or @ is.
 */
export function suggestAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) return { kind: "/" as const, query: slash[1], start: 0 };
  const at = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  return at ? { kind: "@" as const, query: at[1], start: caret - at[1].length - 1 } : null;
}

/** The skills that fit what is typed: names first, then descriptions. */
export function matchSkills(skills: SkillChoice[], query: string) {
  const q = query.toLowerCase();
  const byName = skills.filter((skill) => skill.name.toLowerCase().includes(q));
  const byText = q ? skills.filter((skill) => !byName.includes(skill) && skill.description.toLowerCase().includes(q)) : [];
  return [...byName, ...byText];
}

/** One line of the menu: a skill of the repository, or a command of the AI. */
export interface Suggestion {
  name: string;
  description: string;
  hint?: string;
  skill?: boolean;
  problem?: string;
}

/** The list above the input while a /<name> or @<name> is typed (or, without skills, how to add some). */
export function SuggestMenu({
  kind,
  choices,
  active,
  onPick,
  onHover,
  onManage,
}: {
  kind: "/" | "@";
  choices: Suggestion[];
  active: number;
  onPick: (choice: Suggestion) => void;
  onHover: (index: number) => void;
  /** Shown instead of choices: the repository has no skills yet. */
  onManage?: () => void;
}) {
  // The list scrolls: keep the chosen line in view as the arrows move.
  const list = useRef<HTMLDivElement>(null);
  // (Braces: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.)
  useEffect(() => {
    list.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="command-list" role="listbox" ref={list}>
      {onManage ? (
        <button onMouseDown={(event) => event.preventDefault()} onClick={onManage}>
          <Puzzle size={13} />
          <span className="muted">这个作品库还没有技能，点这里打开「技能」添加</span>
        </button>
      ) : (
        choices.map((choice, index) => (
          <button
            key={`${choice.skill ? "skill" : "command"}:${choice.name}`}
            role="option"
            aria-selected={index === active}
            className={index === active ? "selected" : undefined}
            title={choice.problem ? `⚠ ${choice.problem}` : choice.description}
            // Keep the input's focus (and caret) while picking with the mouse.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(choice)}
          >
            {choice.skill && <Puzzle size={13} />}
            <strong>
              {kind}
              {choice.name}
            </strong>
            {choice.hint && <span className="faint">{choice.hint}</span>}
            <span className="muted ellipsis">{choice.description}</span>
          </button>
        ))
      )}
    </div>
  );
}

/** The names of the repository's skills, so sent messages show their /<name> and @<name> as skills. */
export const SkillNames = createContext<string[]>([]);

/** A message's text with the skills it names (/<name> at its start, @<name> anywhere) marked. */
export function MentionText({ text }: { text: string }) {
  const names = useContext(SkillNames);
  if (!names.length || !/[@/]/.test(text)) return <>{text}</>;
  const parts = text.split(/(^\/[\p{L}\p{N}][\p{L}\p{N}._-]*|(?:^|(?<=\s))@[\p{L}\p{N}][\p{L}\p{N}._-]*)/u);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^[@/]/.test(part) ? part.slice(1).replace(/\.+$/, "") : null;
        if (!name || !names.includes(name)) return <Fragment key={index}>{part}</Fragment>;
        return (
          <Fragment key={index}>
            <span className="skill-mention" title="点名要用的技能">
              {part[0]}
              {name}
            </span>
            {part.slice(1 + name.length)}
          </Fragment>
        );
      })}
    </>
  );
}
