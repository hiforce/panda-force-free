import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const roots = ["src", "scripts", "tests", "release/community", "LICENSES", "patches"];
const files = [
  "package.json",
  "bun.lock",
  "Dockerfile",
  ".dockerignore",
  "eslint.config.mjs",
  "prettier.config.mjs",
  "tsconfig.json",
  "tsconfig.strict.json",
  "tsconfig.contracts.json",
  "tsconfig.tooling.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
const publicFiles = [
  "index.html",
  "style.css",
  "workbench.css",
  "file-preview.css",
  "favicon.svg",
  "assets/panda-mark.svg",
  "assets/panda-icon.png",
];
export function verificationFiles(root = process.cwd()): string[] {
  const result = files.filter((path) => existsSync(join(root, path)));
  for (const path of publicFiles) if (existsSync(join(root, "public", path))) result.push("public/" + path);
  function walk(prefix: string) {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "__pycache__"].includes(entry.name)) continue;
      const path = prefix + "/" + entry.name;
      if (entry.isSymbolicLink()) throw new Error("Verification inputs must be regular files: " + path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !/\.(?:log|pyc|sqlite(?:-wal|-shm)?)$/.test(path)) result.push(path);
    }
  }
  for (const directory of roots) if (existsSync(join(root, directory))) walk(directory);
  return [...new Set(result)].sort();
}
export function sourceIdentity(root = process.cwd()) {
  const files = verificationFiles(root).map((path) => ({
    path,
    executable: Boolean(lstatSync(join(root, path)).mode & 0o111),
    sha256: createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  }));
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
if (import.meta.main) console.log(JSON.stringify(sourceIdentity(), null, 2));
