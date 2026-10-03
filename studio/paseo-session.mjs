/** Reuse the authenticated work gateway and current native route in a separate tab. */
export function standalonePaseoUrl(
  session,
  currentUrl,
  parentUrl,
  activeAgent,
) {
  const parent = new URL(parentUrl);
  const config = session?.bootstrap;
  const basePath = `/paseo/${config?.workId}/`;
  const original = new URL(session?.uiUrl, parent);
  if (
    !config ||
    config.parentOrigin !== parent.origin ||
    config.basePath !== basePath ||
    original.origin !== parent.origin ||
    !original.pathname.startsWith(basePath) ||
    original.searchParams.get("frameNonce") !== config.nonce
  )
    throw new Error("Paseo 返回的作品连接范围无效");
  let url = original;
  if (currentUrl) {
    try {
      const current = new URL(currentUrl, parent);
      if (
        current.origin === parent.origin &&
        current.pathname.startsWith(basePath)
      )
        url = current;
    } catch {
      // An interrupted frame navigation can still reopen the known work session.
    }
  }
  url.searchParams.set("frameNonce", config.nonce);
  url.searchParams.set("frameStandalone", "1");
  if (
    !url.searchParams.has("open") &&
    typeof activeAgent === "string" &&
    activeAgent.length > 0 &&
    activeAgent.length <= 256
  )
    url.searchParams.set("open", "agent:" + activeAgent);
  return url.href;
}

/** Remove retired FRAME chat drafts/preferences without touching native Paseo storage. */
export function clearRetiredChatStorage(storages) {
  for (const storage of storages) {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (
          key?.startsWith("frame.agent-") ||
          key?.startsWith("frame.chat-draft:")
        )
          keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Storage may be disabled; the removed UI never reads these records again.
    }
  }
}
