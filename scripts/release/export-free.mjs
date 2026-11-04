import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { git, sha256, assertReleasePath, inspectText, verifySnapshot } from "./snapshot-lib.mjs";
// Export bytes from one Git tree, not a checkout or a copy of its history/state.
export function exportFree({ source = process.cwd(), ref = "HEAD", destination, allowDirty = false }) {
  source = resolve(source);
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error("Destination already exists; refusing to overwrite it");
  if (!allowDirty && git(source, ["diff", "HEAD", "--name-only"], { encoding: "utf8" }).trim())
    throw new Error("Commit tracked changes before exporting a release");
  const commit = git(source, ["rev-parse", "--verify", ref + "^{commit}"], { encoding: "utf8" }).trim();
  const entries = git(source, ["ls-tree", "-r", "-z", commit], { encoding: "utf8" }).split("\0").filter(Boolean);
  const mapping = new Map();
  for (const entry of entries) {
    const [meta, path] = entry.split("\t");
    const [mode, type] = meta.split(" ");
    const selected =
      /^(?:src|tests|patches|scripts|release\/community)\//.test(path) ||
      /^(?:package\.json|bun\.lock|LICENSES\/upstream-codex-webui-MIT\.txt)$/.test(path) ||
      /^public\/(?:index\.html|style\.css|workbench\.css|file-preview\.css|favicon\.svg|assets\/panda-(?:mark\.svg|icon\.png))$/.test(
        path,
      );
    if (!selected) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("Non-regular export input: " + path);
    assertReleasePath(path);
    mapping.set(path, { source: path, mode });
  }
  for (const name of [
    "README.md",
    "README-zh.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "THIRD_PARTY_NOTICES.md",
    "Dockerfile",
    "docker-compose.yml",
    ".env.example",
    ".gitignore",
    ".dockerignore",
    "UPDATES.md",
    "USAGE.md",
  ])
    mapping.set(name, { source: "release/community/" + name, mode: "100644" });
  mapping.set(".github/workflows/ci.yml", { source: "release/community/ci.yml", mode: "100644" });
  // New files require an explicit public-license review, even under source roots.
  const approved = JSON.parse(
    git(source, ["show", commit + ":release/community/public-files.json"], { encoding: "utf8" }),
  );
  if (!Array.isArray(approved) || new Set(approved).size !== approved.length)
    throw new Error("Invalid approved public inventory");
  for (const path of approved) {
    assertReleasePath(path);
    if (!mapping.has(path)) throw new Error("Approved public file missing: " + path);
  }
  const approvedSet = new Set(approved);
  const excluded = [...mapping.keys()].filter((path) => !approvedSet.has(path));
  for (const path of excluded) mapping.delete(path);
  const files = [],
    prepared = [];
  for (const [path, item] of [...mapping].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertReleasePath(path);
    let bytes = git(source, ["show", commit + ":" + item.source]);
    if (path === "package.json") {
      const pkg = JSON.parse(bytes);
      pkg.name = "panda-force-free";
      pkg.private = true;
      pkg.license = "MIT";
      pkg.repository = "github:hiforce/panda-force-free";
      pkg.bugs = "https://github.com/hiforce/panda-force-free/issues";
      pkg.homepage = "https://github.com/hiforce/panda-force-free#readme";
      bytes = Buffer.from(JSON.stringify(pkg, null, 2) + "\n");
    }
    // Keep the lockfile's root workspace name consistent with the exported manifest.
    if (path === "bun.lock")
      bytes = Buffer.from(bytes.toString().replace(/("name":\s*)"[^"]+"/, '$1"panda-force-free"'));
    if (!/\.(?:png|woff2?|ttf|ico)$/i.test(path)) inspectText(path, bytes);
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes), mode: item.mode });
    prepared.push({ path, bytes, mode: item.mode });
  }
  const manifest = {
    format: 1,
    edition: "panda-force-free",
    maintenance: "Best effort; no SLA, guaranteed response time or fix deadline.",
    files,
    contentSha256: sha256(JSON.stringify(files)),
  };
  mkdirSync(destination, { recursive: true });
  for (const item of prepared) {
    const path = resolve(destination, item.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.bytes);
    chmodSync(path, item.mode === "100755" ? 0o755 : 0o644);
  }
  writeFileSync(resolve(destination, "SNAPSHOT.json"), JSON.stringify(manifest, null, 2) + "\n");
  verifySnapshot(destination);
  return { sourceCommit: commit, destination, contentSha256: manifest.contentSha256, files: files.length, excluded };
}
if (import.meta.main) {
  const args = process.argv.slice(2),
    get = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  const destination = get("--out");
  if (!destination) throw new Error("Usage: bun scripts/release/export-free.mjs --out NEW_DIRECTORY [--ref COMMIT]");
  console.log(JSON.stringify(exportFree({ ref: get("--ref") || "HEAD", destination }), null, 2));
}
