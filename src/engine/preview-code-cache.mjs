import { parse } from "es-module-lexer/minimal/js";

/**
 * Rewrite only module syntax and resource URLs tied to a real import.meta.url.
 * @param {string} code
 * @param {string} original
 * @param {(url: string) => string | undefined} resourceUrl
 * @returns {string}
 */
export function rewritePreviewCode(code, original, resourceUrl) {
  const imports = parse(code)[0],
    edits = [];
  const add = (start, end, text) => edits.push({ start, end, text });
  const resolver =
    "(specifier=>{const value=String(specifier);return /^(?:[./]|https?:|blob:)/.test(value)?new URL(value," +
    JSON.stringify(original) +
    ").href:value})";
  const known = (value) => {
    try {
      return resourceUrl(new URL(value, original).href);
    } catch {
      return undefined;
    }
  };
  for (const item of imports) {
    if (item.d === -2) {
      const suffix = /^\s*\.\s*url\b/.exec(code.slice(item.e));
      if (suffix) {
        const prefix = code.slice(0, item.s);
        const argument = /\bnew\s+URL\(\s*(["'`])([^"'\`\\\n]*)\1\s*,\s*$/.exec(
          prefix,
        );
        if (argument) {
          const value = known(argument[2]);
          if (value) {
            const start =
              prefix.length -
              argument[0].length +
              argument[0].indexOf(argument[1]);
            add(start, start + argument[2].length + 2, JSON.stringify(value));
          }
        }
        add(item.s, item.e + suffix[0].length, JSON.stringify(original));
      } else {
        const resolve = /^\s*\.\s*resolve\b/.exec(code.slice(item.e));
        if (resolve) add(item.s, item.e + resolve[0].length, resolver);
      }
      continue;
    }
    if (item.n !== undefined) {
      const value = known(item.n);
      if (!value) continue;
      const quoted = /["'`]/.test(code[item.s]);
      add(
        quoted ? item.s : item.s - 1,
        quoted ? item.e : item.e + 1,
        JSON.stringify(value),
      );
    } else if (item.d >= 0 && item.e > item.s) {
      // Evaluate a computed specifier exactly once, retaining nested import/meta syntax.
      add(item.s, item.s, resolver + "(");
      add(item.e, item.e, ")");
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of edits)
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}
