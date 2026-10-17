// Scripts written with spaces between words: recognized sentences in them are joined with one.
const SPACED_END = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Hangul}\d.,!?;:'")\]%]$/u;
const SPACED_START = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Hangul}\d"'([]/u;
const spaced = (left: string, right: string) => SPACED_END.test(left) && SPACED_START.test(right);

/** Recognized sentences as one text. */
export function joinSpoken(parts: string[]): string {
  return parts.reduce((all, part) => (all && part ? all + (spaced(all, part) ? " " : "") + part : all || part), "");
}

/** The spoken text put in between what was before and after the cursor; `cursor` is just after it. */
export function placeSpoken(before: string, spoken: string, after: string): { text: string; cursor: number } {
  const lead = before && spoken && spaced(before, spoken) ? " " : "";
  const tail = spoken && after && spaced(spoken, after) ? " " : "";
  const head = before + lead + spoken;
  return { text: head + tail + after, cursor: head.length };
}
