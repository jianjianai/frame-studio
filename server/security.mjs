import fs from "node:fs";
import path from "node:path";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function passwordMatches(password, encoded) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const [salt, value] = encoded.split(":");
  const actual = Buffer.from(passwordHash(password, salt).split(":")[1], "hex");
  const expected = Buffer.from(value, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function vault(key) {
  const secret = Buffer.from(key, "hex");
  if (secret.length !== 32)
    throw new Error("FRAME_MASTER_KEY must contain 64 hex characters");
  return {
    encrypt(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", secret, iv);
      const body = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    decrypt(value) {
      const buffer = Buffer.from(value, "base64"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          secret,
          buffer.subarray(0, 12),
        );
      decipher.setAuthTag(buffer.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(buffer.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
    },
  };
}
export function problem(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}
export function confined(base, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.length > 1024 ||
    /[\\\x00-\x1f:]/.test(relative)
  )
    throw problem(400, "Invalid path");
  const parts = relative.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p === ".git" ||
        p === "node_modules" ||
        p === ".env" ||
        p.startsWith(".env."),
    )
  )
    throw problem(400, "Invalid path");
  let current = path.resolve(base);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (
        st.isSymbolicLink() ||
        (st.isFile() && st.nlink > 1) ||
        (!st.isFile() && !st.isDirectory())
      )
        throw problem(400, "Links and special files are not allowed");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}
export function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(file) {
      const name = path.basename(file);
      if (
        [
          ".git",
          "node_modules",
          ".cache",
          ".history",
          "exports",
          ".env",
        ].includes(name) ||
        name.startsWith(".env.")
      )
        return false;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1))
        throw problem(400, "Unsafe link in project");
      return true;
    },
  });
}
export function treeHash(root) {
  const files = [];
  function walk(dir, rel = "") {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (
        [".git", "node_modules", ".cache", ".history", "exports"].includes(name)
      )
        continue;
      const r = rel ? rel + "/" + name : name,
        file = confined(root, r),
        st = fs.statSync(file);
      if (st.isDirectory()) walk(file, r);
      else files.push([r, hash(fs.readFileSync(file))]);
    }
  }
  walk(root);
  return hash(JSON.stringify(files));
}
export function allowedGitUrl(value) {
  if (
    !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(
      value,
    )
  )
    throw problem(400, "Use https://github.com/owner/repository");
  return value;
}
