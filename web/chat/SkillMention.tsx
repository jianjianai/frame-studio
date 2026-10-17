import { createContext, Fragment, useContext, useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import { api, skillsPath, useServerEvent } from "../lib/api";

/** A skill of the work's repository, as @<name> offers it (server/skills.mjs). */
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

/** An @<name> being typed just before the caret (at the start or after a space): what is typed so far and where the @ is. */
export function mentionAt(text: string, caret: number) {
  const match = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text.slice(0, caret));
  return match ? { query: match[1], start: caret - match[1].length - 1 } : null;
}

/** The skills that fit what is typed after @: names first, then descriptions. */
export function matchSkills(skills: SkillChoice[], query: string) {
  const q = query.toLowerCase();
  const byName = skills.filter((skill) => skill.name.toLowerCase().includes(q));
  const byText = q ? skills.filter((skill) => !byName.includes(skill) && skill.description.toLowerCase().includes(q)) : [];
  return [...byName, ...byText];
}

/** The list above the input while an @<name> is typed (or, without skills, how to add some). */
export function SkillMenu({
  choices,
  active,
  empty,
  onPick,
  onHover,
  onManage,
}: {
  choices: SkillChoice[];
  active: number;
  /** The repository has no skills at all. */
  empty: boolean;
  onPick: (skill: SkillChoice) => void;
  onHover: (index: number) => void;
  onManage: () => void;
}) {
  return (
    <div className="command-list" role="listbox">
      {empty ? (
        <button onMouseDown={(event) => event.preventDefault()} onClick={onManage}>
          <Puzzle size={13} />
          <span className="muted">这个作品库还没有技能，点这里打开「技能」添加</span>
        </button>
      ) : (
        choices.map((skill, index) => (
          <button
            key={skill.name}
            role="option"
            aria-selected={index === active}
            className={index === active ? "selected" : undefined}
            title={skill.problem ? `⚠ ${skill.problem}` : skill.description}
            // Keep the input's focus (and caret) while picking with the mouse.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(skill)}
          >
            <Puzzle size={13} />
            <strong>@{skill.name}</strong>
            <span className="muted ellipsis">{skill.description}</span>
          </button>
        ))
      )}
    </div>
  );
}

/** The names of the repository's skills, so sent messages show their @<name> as skills. */
export const SkillNames = createContext<string[]>([]);

/** A message's text with the skills it names (@<name>) marked. */
export function MentionText({ text }: { text: string }) {
  const names = useContext(SkillNames);
  if (!names.length || !text.includes("@")) return <>{text}</>;
  const parts = text.split(/((?:^|(?<=\s))@[\p{L}\p{N}][\p{L}\p{N}._-]*)/u);
  return (
    <>
      {parts.map((part, index) => {
        const name = part.startsWith("@") ? part.slice(1).replace(/\.+$/, "") : null;
        if (!name || !names.includes(name)) return <Fragment key={index}>{part}</Fragment>;
        return (
          <Fragment key={index}>
            <span className="skill-mention" title="点名要用的技能">
              @{name}
            </span>
            {part.slice(1 + name.length)}
          </Fragment>
        );
      })}
    </>
  );
}
