import { CLIENT_ENTRYPOINTS } from "../../src/shared/client-entrypoints.js";
import { BUILTIN_SKILL_COVERS } from "../../src/shared/skills/cover-assets.js";
import { CREATION_STYLES, TEMPLATE_PREVIEW_ASSETS } from "../../src/shared/template-previews/assets.js";
import { INSTALL_ASSETS } from "../../src/shared/install-assets.js";
import { KNOWLEDGE_STYLES, CLI_STYLES, BOT_STYLES, DATABASE_STYLES } from "../../src/shared/interface-assets.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const roots = [
  "src",
  "public",
  "scripts",
  "tests",
  "release/community",
  "LICENSES",
  "patches",
  "deploy/documents",
  "deploy/previews",
  "deploy/search",
];
const files = [
  "package.json",
  "bun.lock",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.build.yml",
  "docker-compose.documents.yml",
  "docker-compose.previews.yml",
  "docker-compose.search.yml",
  "docker-compose.documents.registry.yml",
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
  ...CREATION_STYLES.map((path) => path.slice(1)),
  ...TEMPLATE_PREVIEW_ASSETS.map((path) => path.slice(1)),
  ...Object.values(BUILTIN_SKILL_COVERS).map((path) => path.slice(1)),
  "index.html",
  "style.css",
  "workbench.css",
  // Gadget CSS is generated from stylesheet inputs under src, already included below.
  "documents.css",
  "document-authoring.css",
  "document-workspace.css",
  "document-code.css",
  "document-publication.css",
  "packages.css",
  "workbench-forms.css",
  ...KNOWLEDGE_STYLES.map((path) => path.slice(1)),
  ...CLI_STYLES.map((path) => path.slice(1)),
  ...BOT_STYLES.map((path) => path.slice(1)),
  ...DATABASE_STYLES.map((path) => path.slice(1)),
  "source-import.css",
  "publishing.css",
  "builds.css",
  "delivery.css",
  "social.css",
  "session-workspace.css",
  "message-composer.css",
  "settings-workspace.css",
  "workbench-chrome.css",
  "workbench-layout.css",
  "creative.css",
  "appearance.css",
  "file-preview.css",
  "favicon.svg",
  "assets/panda-mark.svg",
  "assets/panda-icon.png",
  ...INSTALL_ASSETS.map((path) => path.slice(1)),
];
const generatedPublicFiles = new Set([
  "public/gadget.css",
  ...Object.values(CLIENT_ENTRYPOINTS).map((name) => "public/" + name),
]);
export function verificationFiles(root = process.cwd()): string[] {
  const result = files.filter((path) => existsSync(join(root, path)));
  for (const path of publicFiles) if (existsSync(join(root, "public", path))) result.push("public/" + path);
  function walk(prefix: string) {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "__pycache__"].includes(entry.name)) continue;
      const path = prefix + "/" + entry.name;
      if (
        generatedPublicFiles.has(path) ||
        path === "public/locales" ||
        (path.startsWith("public/") && path.endsWith(".map"))
      )
        continue;
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
