import { useEffect, useState } from "react";
import { api, workPath } from "../lib/api";
import type { WorkInfo } from "../lib/types";

/** What a page may do in its frame: run, open windows and dialogs, download; never act as the studio. */
export const PAGE_SANDBOX = "allow-scripts allow-popups allow-modals allow-downloads";

// Signed page addresses last a day (server/routes/works.mjs): asked for again after half of it.
const links = new Map<string, { base: string; at: number }>();
const LINK_REUSE_MS = 12 * 3600_000;

/** The address of a work's file as a page, or null until known. */
export function usePageUrl(work: WorkInfo, file: string, version?: number | string) {
  const key = `${work.repo}/${work.id}`;
  const known = links.get(key);
  const [base, setBase] = useState<string | null>(known && Date.now() - known.at < LINK_REUSE_MS ? known.base : null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (base) return;
    let current = true;
    api<{ base: string }>(`${workPath(work.repo, work.id)}/page-link`).then(
      (link) => {
        links.set(key, { base: link.base, at: Date.now() });
        if (current) setBase(link.base);
      },
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [base, key, work.repo, work.id]);
  const url = base ? base + file.split("/").map(encodeURIComponent).join("/") + (version ? `?v=${version}` : "") : null;
  return { url, error };
}

/**
 * An HTML file of the work shown as a page. It runs sandboxed, an origin of its own, and loads
 * the files it names by their relative paths in the work; any size (the code view stops at 2 MiB).
 */
export function PageViewer({ work, file, version }: { work: WorkInfo; file: string; version?: number }) {
  const { url, error } = usePageUrl(work, file, version);
  if (!url) return <div className="empty">{error || "正在打开页面…"}</div>;
  return <iframe key={url} className="page-frame" src={url} sandbox={PAGE_SANDBOX} title={file} />;
}
