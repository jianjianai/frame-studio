import { api, workPath } from "../lib/api";
import type { WorkInfo } from "../lib/types";

export interface Uploaded {
  path: string;
  url: string;
  size: number;
}

/** Upload files into a work folder (default public/). Picks free names. */
export async function uploadBlobs(work: Pick<WorkInfo, "repo" | "id">, files: File[], folder = "public", onProgress?: (done: number) => void) {
  const results: Uploaded[] = [];
  for (const [index, file] of files.entries()) {
    const name = file.name.replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_");
    results.push(
      await api<Uploaded>(`${workPath(work.repo, work.id)}/upload?path=${encodeURIComponent(`${folder}/${name}`)}&unique=1`, {
        raw: file,
        contentType: file.type || "application/octet-stream",
      }),
    );
    onProgress?.(index + 1);
  }
  return results;
}

/** Open a file picker and upload the chosen files. */
export function uploadFiles(work: Pick<WorkInfo, "repo" | "id">, folder = "public", accept = "") {
  return new Promise<Uploaded[]>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => uploadBlobs(work, [...(input.files ?? [])], folder).then(resolve, reject);
    input.click();
  });
}
