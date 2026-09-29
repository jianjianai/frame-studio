import fs from "node:fs/promises";
import path from "node:path";

// One-shot deployment migration, mounted only at /data, with no network or Docker socket.
const root = "/data";
if (process.getuid?.() !== 0) throw Error("Data ownership initialization requires the one-shot root service");
await fs.mkdir(root, { recursive: true, mode: 0o750 });
if (await fs.realpath(root) !== root) throw Error("Data directory cannot be a symbolic link");
const marker = path.join(root, ".frame-ownership-v1");
try {
  await fs.access(marker);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const own = async file => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return; // Never traverse a host link while privileged.
    if (stat.isFile() && stat.nlink > 1) throw Error("Resolve hard-linked data before ownership migration: " + file);
    if (!stat.isDirectory() && !stat.isFile()) throw Error("Unexpected special file in persistent data: " + file);
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await own(path.join(file, name));
    await fs.chown(file, 1000, 1000);
  };
  await own(root);
  await fs.writeFile(marker, "uid=1000 gid=1000\n", { mode: 0o600, flag: "wx" });
  await fs.chown(marker, 1000, 1000);
}
