/** Sandboxed players may have opaque origins: persistence is best-effort. */
export function readPreference<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) as T; }
  catch { return fallback; }
}
export function writePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The parent can persist embedded preferences. */ }
}
export function boundedPreference(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
