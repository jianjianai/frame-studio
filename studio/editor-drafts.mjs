const absent = Symbol("absent");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const stableJson = (value) =>
  JSON.stringify(value, (_, item) =>
    object(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const equal = (a, b) =>
  a === absent || b === absent ? a === b : stableJson(a) === stableJson(b);
/** Merge independently edited JSON fields. Arrays are atomic. Conflicts never silently
 * choose a winner; the caller must explicitly choose draft or current. */
export function mergeJsonDraft(base, draft, current, prefer) {
  const conflicts = [];
  const merge = (b, d, c, path) => {
    if (equal(d, b)) return c;
    if (equal(c, b) || equal(d, c)) return d;
    if (object(d) && object(c) && (b === absent || object(b))) {
      const entries = [];
      for (const key of new Set([
        ...Object.keys(b === absent ? {} : b),
        ...Object.keys(d),
        ...Object.keys(c),
      ])) {
        const own = (value, key) =>
          value !== absent && Object.hasOwn(value, key) ? value[key] : absent;
        const next = merge(own(b, key), own(d, key), own(c, key), [
          ...path,
          key,
        ]);
        if (next !== absent) entries.push([key, next]);
      }
      return Object.fromEntries(entries);
    }
    conflicts.push(path.join("."));
    return prefer === "current" ? c : d;
  };
  return { value: merge(base, draft, current, []), conflicts };
}
export function parseNumberDraft(
  text,
  { min = -Infinity, max = Infinity, allowExpression = false } = {},
) {
  const trimmed = text.trim();
  if (!trimmed) return { error: "请输入数值；按 Escape 恢复" };
  const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed);
  if (!numeric && /^[+\-.\deE]+$/.test(trimmed))
    return { error: "请输入完整数字；按 Escape 恢复" };
  if (!numeric && allowExpression && trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed);
      if (
        object(value) &&
        Object.values(value).every(
          (item) => typeof item === "number" && Number.isFinite(item),
        )
      )
        return { value };
    } catch {}
    return { error: "请输入合法的 Tone 数量对象" };
  }
  if (!numeric)
    return allowExpression
      ? { value: trimmed }
      : { error: "请输入完整数字；按 Escape 恢复" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { error: "请输入有限数字" };
  if (value < min || value > max) return { error: `范围 ${min} 到 ${max}` };
  return { value };
}

/** Presets and manual DSP windows are mutually exclusive in the editor. */
export const stretchMode = (options) =>
  options?.blockMs ? "manual" : (options?.preset ?? "default");
export function stretchPreset(options, preset) {
  if (preset === "manual") {
    const blockMs = options?.blockMs || 120;
    return {
      ...options,
      blockMs,
      intervalMs: Math.min(blockMs, options?.intervalMs || 30),
    };
  }
  return { ...options, preset, blockMs: 0, intervalMs: 0 };
}
