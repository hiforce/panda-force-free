import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError, cliObject } from "../shared/cli/contracts.js";
import { agentPackage } from "./agent-guide.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function pandaIntegration(
  action: "install" | "inspect" | "uninstall",
  target: string,
  directory: string,
  profile: string,
) {
  if (!["codex", "claude"].includes(target) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
    throw new CliError("invalidInput");
  const root = resolve(directory),
    destination = join(root, "panda"),
    expected = agentPackage(profile),
    manifest = {
      schema: 1,
      target,
      profile,
      files: Object.fromEntries(Object.entries(expected).map(([name, bytes]) => [name, hash(bytes)])),
    };
  const info = await lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new CliError("conflict", 409);
  let ownedFiles: string[] = [];
  if (info) {
    const references = await lstat(join(destination, "references"));
    if (!references.isDirectory() || references.isSymbolicLink()) throw new CliError("conflict", 409);
    const ownership = join(destination, ".panda-install.json");
    const owned = await lstat(ownership);
    if (!owned.isFile() || owned.isSymbolicLink() || owned.size > 16384) throw new CliError("conflict", 409);
    let old: Record<string, unknown>;
    try {
      old = cliObject(JSON.parse(await readFile(ownership, "utf8")), ["schema", "target", "profile", "files"]);
      const files = cliObject(old.files, Object.keys((old.files || {}) as object));
      ownedFiles = Object.keys(files);
      if (
        old.schema !== 1 ||
        old.target !== target ||
        old.profile !== profile ||
        !ownedFiles.includes("SKILL.md") ||
        ownedFiles.length > 32 ||
        ownedFiles.some((name) => name !== "SKILL.md" && !/^references\/[a-z0-9-]+\.(?:md|json)$/.test(name)) ||
        Object.values(files).some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      )
        throw Error("Invalid ownership manifest");
      for (const [name, digest] of Object.entries(files)) {
        const path = join(destination, name),
          file = await lstat(path);
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.size > 1024 * 1024 ||
          hash(await readFile(path, "utf8")) !== digest
        )
          throw Error("Managed file changed");
      }
    } catch {
      throw new CliError("conflict", 409);
    }
    const previous = old.files as Record<string, string>;
    const updateAvailable =
      ownedFiles.length !== Object.keys(expected).length ||
      Object.entries(manifest.files).some(([name, hash]) => previous[name] !== hash);
    if (action === "inspect") return { target, directory: destination, installed: true, profile, updateAvailable };
    if (action === "install" && updateAvailable) throw new CliError("conflict", 409);
  }
  if (action === "inspect")
    return { target, directory: destination, installed: !!info, profile, updateAvailable: false };
  if (action === "uninstall") {
    if (info) {
      for (const name of ownedFiles) await rm(join(destination, name));
      await rm(join(destination, ".panda-install.json"));
      await rmdir(join(destination, "references")).catch((error) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
      await rmdir(destination).catch((error) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
    }
    return { target, removed: !!info, directory: destination };
  }
  if (!info) {
    await mkdir(root, { recursive: true });
    const parent = await lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new CliError("conflict", 409);
    const staging = join(root, ".panda-" + randomUUID());
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const [name, bytes] of Object.entries(expected)) {
        const path = join(staging, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { mode: 0o644, flag: "wx" });
      }
      await writeFile(join(staging, ".panda-install.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return { target, installed: true, directory: destination, profile };
}
