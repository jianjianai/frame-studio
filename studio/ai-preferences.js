import { useEffect, useState } from "react";
const key = "frame.ai-preferences.v1";
const changed = "frame-ai-preferences";
export function readAiPreferences() {
  let value;
  try {
    value = JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    value = {};
  }
  if (!value || typeof value !== "object") value = {};
  return {
    sendShortcut: value.sendShortcut === "enter" ? "enter" : "mod-enter",
    fontSize: [13, 14, 15, 16].includes(value.fontSize) ? value.fontSize : 14,
    favorites: Array.isArray(value.favorites)
      ? value.favorites.filter((v) => typeof v === "string").slice(0, 200)
      : [],
    defaultSelection:
      value.defaultSelection &&
      typeof value.defaultSelection.connection === "string" &&
      typeof value.defaultSelection.model === "string"
        ? value.defaultSelection
        : null,
  };
}
export function saveAiPreferences(patch) {
  const next = { ...readAiPreferences(), ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* Preferences never block creation. */
  }
  window.dispatchEvent(new Event(changed));
  return next;
}
export function useAiPreferences() {
  const [value, setValue] = useState(readAiPreferences);
  useEffect(() => {
    const refresh = () => setValue(readAiPreferences());
    window.addEventListener(changed, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changed, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return [value, saveAiPreferences];
}

/** Remove only browser shortcuts for a provider explicitly deleted in this browser. */
export function forgetProviderPreferences(connection) {
  const preferences = readAiPreferences();
  const favorites = preferences.favorites.filter((key) => {
    try {
      return JSON.parse(key)?.[0] !== connection;
    } catch {
      return true;
    }
  });
  saveAiPreferences({
    favorites,
    defaultSelection:
      preferences.defaultSelection?.connection === connection
        ? null
        : preferences.defaultSelection,
  });
}
