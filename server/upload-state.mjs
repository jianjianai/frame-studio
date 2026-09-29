import fs from "node:fs";
import path from "node:path";
import { problem } from "./security.mjs";
export function readUpload(data, id) {
  const dir = path.join(data, "uploads", id);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw Object.assign(
        problem(404, "Upload not found or expired; start a new upload."),
        { code: "UPLOAD_NOT_FOUND", recovery: "upload-begin" },
      );
    throw Object.assign(
      problem(
        409,
        "Upload metadata is unreadable; preserve this upload for recovery.",
      ),
      { code: "UPLOAD_RECOVERY_REQUIRED", recovery: "check-upload-storage" },
    );
  }
  if (
    !meta ||
    !Number.isSafeInteger(meta.bytes) ||
    meta.bytes <= 0 ||
    typeof meta.sha256 !== "string"
  )
    throw problem(409, "Upload metadata is invalid; preserve it for recovery.");
  return { dir, meta };
}
