import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
}
// Reject agent metadata at every depth, even if a future allowlist is broadened.
export function assertReleasePath(path) {
  if (path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === ".."))
    throw new Error("Unsafe release path: " + path);
  const parts = path.split("/");
  if (/^(?:release\/community|panda-docs)\/(?:\.gitignore|\.dockerignore|\.env.example)$/.test(path)) return;
  const permittedDot = [".gitignore", ".dockerignore", ".env.example"].includes(path);
  if (parts.some((p) => p.startsWith(".")) && !permittedDot) throw new Error("Private metadata path: " + path);
  if (parts.slice(1).some((p) => p.startsWith("."))) throw new Error("Nested private metadata path: " + path);
  if (/(?:^|\/)(?:AGENTS|SKILL|MEMORY)\.md$/i.test(path) || /\.(?:sqlite(?:-wal|-shm)?|pem|key|log)$/i.test(path))
    throw new Error("Private state path: " + path);
}
export function inspectText(path, bytes) {
  const text = bytes.toString("utf8");
  const patterns = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["cloud access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{16,}\b/],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ["signed asset URL", /[?&](?:x-oss-signature|X-Amz-Signature)=[a-f0-9]{24,}/i],
    [
      "internal endpoint",
      /(?:harbor|spark|codex|panda|oss)\.hiforce\.ai|e\.coding\.net\/hiforce|hiforce-inc\.slack\.com/,
    ],
  ];
  for (const [name, pattern] of patterns) if (pattern.test(text)) throw new Error(name + " found in " + path);
}
export function releaseFiles(root) {
  const result = [];
  function walk(prefix = "") {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      assertReleasePath(path);
      const absolute = join(root, path),
        stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("Symlink in release: " + path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) result.push(path);
      else throw new Error("Unsupported release file: " + path);
    }
  }
  walk();
  return result.sort();
}
export function verifySnapshot(root) {
  const manifestPath = join(root, "SNAPSHOT.json");
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink())
    throw new Error("Snapshot manifest must be a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported snapshot manifest");
  const files = releaseFiles(root),
    expected = manifest.files.map((x) => x.path).sort();
  if (JSON.stringify(files.filter((x) => x !== "SNAPSHOT.json")) !== JSON.stringify(expected))
    throw new Error("Snapshot inventory differs from manifest");
  const approved = JSON.parse(readFileSync(join(root, "release/community/public-files.json"), "utf8"));
  if (
    !Array.isArray(approved) ||
    new Set(approved).size !== approved.length ||
    JSON.stringify([...approved].sort()) !== JSON.stringify(expected)
  )
    throw new Error("Snapshot differs from approved public inventory");
  for (const item of manifest.files) {
    assertReleasePath(item.path);
    const path = join(root, item.path),
      bytes = readFileSync(path);
    const mode = lstatSync(path).mode & 0o111 ? "100755" : "100644";
    if (mode !== item.mode) throw new Error("Snapshot mode changed: " + item.path);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256)
      throw new Error("Snapshot file changed: " + item.path);
    if (!/\.(png|jpg|jpeg|woff2?|ttf|ico)$/i.test(item.path)) inspectText(item.path, bytes);
  }
  if (sha256(JSON.stringify(manifest.files)) !== manifest.contentSha256) throw new Error("Snapshot digest differs");
  return manifest;
}
