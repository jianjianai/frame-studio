import fs from "node:fs";
import { authoringReferences } from "../src/contracts/authoring.mjs";
import { safePath, fail } from "./mcp/workspace.mjs";

export function referenceCatalog() {
  return Object.entries(authoringReferences).map(([name, value]) => ({ name, ...value, uri: "frame://reference/" + name }));
}
export function readAuthoringReference(root, name) {
  if (!Object.hasOwn(authoringReferences, name))
    fail("UNKNOWN_REFERENCE", "Choose a reference from the catalog.", { references: referenceCatalog() });
  const reference = authoringReferences[name], file = safePath(root, reference.path);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 1024 * 1024)
    fail("INVALID_REFERENCE", "Reference must be an owned regular file within 1 MiB.");
  return { name, ...reference, uri: "frame://reference/" + name, content: fs.readFileSync(file, "utf8") };
}
