import fs from "node:fs";
import { validProjectId } from "../../../scripts/project-metadata.mjs";

/** Original deterministic audiovisual fixture, emitted as ordinary project source. */
export function filmSources(id) {
  if (!validProjectId(id)) throw new Error("Invalid fixture project ID");
  const metadata = JSON.parse(
    fs.readFileSync(new URL("./metadata.json", import.meta.url), "utf8"),
  );
  Object.assign(metadata, { id, poster: `films/${id}/poster.svg` });
  return {
    "project.ts": `import type { AnimationProject } from '../../src/engine/types';\nconst project: AnimationProject = { ...${JSON.stringify(metadata, null, 2)}, load: () => import('./scene'), loadAudio: () => import('./audio') };\nexport default project;\n`,
    "scene.ts": fs.readFileSync(
      new URL("./scene.ts.txt", import.meta.url),
      "utf8",
    ),
    "audio.ts": fs.readFileSync(
      new URL("./audio.ts.txt", import.meta.url),
      "utf8",
    ),
  };
}
