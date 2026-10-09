/**
 * Partial updates shared by visual.json and audio.json edits. Nested objects merge field by
 * field, so changing transform.opacity keeps transform.x; arrays (keyframes, processors,
 * automation) are replaced whole, and an object whose `kind` changes is replaced too.
 */
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function mergePatch(target, patch) {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = target?.[key];
    const sameKind = !(plain(value) && plain(current) && value.kind !== undefined && current.kind !== undefined && value.kind !== current.kind);
    out[key] = plain(value) && plain(current) && sameKind ? mergePatch(current, value) : structuredClone(value);
  }
  return out;
}

/** Delete "fadeIn" or a nested "transform.opacity"; parent objects left empty go too. */
export function unsetPath(target, path) {
  const keys = path.split(".");
  const parents = [target];
  for (const key of keys.slice(0, -1)) {
    const next = parents.at(-1)[key];
    if (!plain(next)) return;
    parents.push(next);
  }
  delete parents.at(-1)[keys.at(-1)];
  for (let i = parents.length - 1; i > 0 && !Object.keys(parents[i]).length; i--) delete parents[i - 1][keys[i - 1]];
}
