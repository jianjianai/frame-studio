import { api, workPath } from "./api";

/** What a work's cover is made from (see server/covers.mjs). */
export interface CoverState {
  /** Version of the cached cover image; "" while there is none. */
  cover: string;
  /** A frame picked automatically, the frame at a chosen time, or an image of the work. */
  mode: "auto" | "time" | "image";
  poster: string;
  /** The moment the cached frame shows (null for an image). */
  time: number | null;
  /** The work changed since the cover was made: a new one is being made. */
  updating: boolean;
  error: string;
}

/** The cached cover; a matching `version` lets the browser keep it for good. */
export const coverUrl = (repo: string, id: string, version: string) => `${workPath(repo, id)}/cover?v=${encodeURIComponent(version)}`;

export const coverFromFrame = (repo: string, id: string, time: number) => api<CoverState>(`${workPath(repo, id)}/cover/frame`, { body: { time } });

export const automaticCover = (repo: string, id: string) => api<CoverState>(`${workPath(repo, id)}/cover`, { method: "DELETE" });

/** Pick an image and make it the cover; null when nothing was picked. */
export function uploadCover(repo: string, id: string) {
  return new Promise<CoverState | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      api<CoverState>(`${workPath(repo, id)}/cover/image`, { raw: file, contentType: file.type || "application/octet-stream" }).then(resolve, reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
