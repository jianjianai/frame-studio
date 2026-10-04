/** Resolve only routes served by the shared native AI gateway. */
export function nativeAiUrl(value, parentUrl) {
  const parent = new URL(parentUrl),
    url = new URL(value, parent);
  if (
    typeof value !== "string" ||
    url.origin !== parent.origin ||
    !url.pathname.startsWith("/ai/")
  )
    throw new Error("AI 工作台返回的连接范围无效");
  return url;
}

/** Validate the work binding before showing or connecting the native iframe. */
export function embeddedAiUrl(
  session,
  parentUrl,
  workId = session?.bootstrap?.workId,
) {
  const config = session?.bootstrap,
    parent = new URL(parentUrl);
  const url = nativeAiUrl(session?.uiUrl, parentUrl);
  if (
    !config ||
    config.workId !== workId ||
    config.parentOrigin !== parent.origin ||
    config.basePath !== "/ai/" ||
    config.embedPath !== `/ai/works/${workId}/` ||
    url.pathname !== config.embedPath ||
    url.searchParams.get("frameNonce") !== config.nonce
  )
    throw new Error("AI 工作台返回的作品连接范围无效");
  return url.href;
}

/** Open the full native workbench, retaining the currently selected conversation. */
export function standaloneAiUrl(session, currentUrl, parentUrl) {
  embeddedAiUrl(session, parentUrl);
  const config = session.bootstrap;
  let url = nativeAiUrl(session.standaloneUrl || config.basePath, parentUrl);
  if (currentUrl) {
    try {
      const current = nativeAiUrl(currentUrl, parentUrl);
      if (!current.pathname.startsWith("/ai/works/")) url = current;
    } catch {
      /* An interrupted navigation can reopen the known native workbench. */
    }
  }
  url.searchParams.delete("frameNonce");
  url.searchParams.set("frameStandalone", "1");
  return url.href;
}

/** Remove retired FRAME chat drafts/preferences without touching native AI storage. */
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
      /* Storage can be disabled; these records are no longer read. */
    }
  }
}
