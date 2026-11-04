import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrowseRoots } from "./workspace/folders.js";

// Works both from source (src/server/config.ts) and from the bundled dist/server.js.
function findProjectRoot(start: string) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "public")) && existsSync(resolve(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("Could not locate the project root containing public/");
}

const host = process.env.HOST || "127.0.0.1";
const homeDir = process.env.HOME || process.cwd();
const codexHome = process.env.CODEX_HOME || join(homeDir, ".codex");
const appRoot = findProjectRoot(import.meta.dir);
const projectless = process.env.CODEX_WEBUI_PROJECTLESS === "true";
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (projectless ? homeDir : appRoot));
const browseRoots = defaultBrowseRoots(homeDir);
const legacyAttachmentRoot = resolve(codexHome, "codex-webui-uploads");
const attachmentRoot = resolve(process.env.CODEX_WEBUI_ATTACHMENT_ROOT || legacyAttachmentRoot);
const stateRoot = resolve(process.env.PANDA_FORCE_HOME || join(homeDir, ".panda-force"));

export const config = Object.freeze({
  host,
  port: Number(process.env.PORT || 8899),
  localhostOnly: host === "127.0.0.1" || host === "::1" || host === "localhost",
  passwordInitialization: process.argv.includes("--setup-password"),
  accessToken: process.env.CODEX_WEBUI_ACCESS_TOKEN || null,
  environmentPassword: process.env.CODEX_WEBUI_PASSWORD || null,
  authMode: process.env.CODEX_WEBUI_AUTH_MODE || null,
  appRoot,
  publicDir: resolve(appRoot, "public"),
  homeDir,
  codexHome,
  projectless,
  configuredReviewRoot,
  ntfyTopic: process.env.CODEX_WEBUI_NTFY_TOPIC || null,
  ntfyUrl: (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
  defaultCwd,
  browseRoots,
  attachmentRoot,
  stateRoot,
  projectCatalogPath: resolve(stateRoot, "data", "projects.sqlite"),
  projectVisibilityPath: resolve(codexHome, "codex-webui-project-visibility.json"),
  defaultCodexSessionsRoot: resolve(codexHome, "sessions"),
  imageRoots: [
    ...new Set([
      ...browseRoots,
      attachmentRoot,
      legacyAttachmentRoot,
      resolve(codexHome, "generated_images"),
      resolve(tmpdir()),
      resolve("/tmp"),
    ]),
  ],
  fileRoots: [
    ...new Set([...browseRoots, attachmentRoot, legacyAttachmentRoot, defaultCwd, resolve(tmpdir()), resolve("/tmp")]),
  ],
  reviewRoots: [resolve(configuredReviewRoot || defaultCwd)],
});

/** Startup guardrails that need to know how authentication was resolved. */
export function assertStartupAuth({ idaasEnabled }: { idaasEnabled: boolean }) {
  if (config.passwordInitialization && !config.localhostOnly) {
    throw new Error(
      "Password initialization must listen on localhost. Use HOST=127.0.0.1 bun run src/server/main.ts --setup-password",
    );
  }
  if (config.passwordInitialization && idaasEnabled)
    throw new Error("Password initialization is disabled in IDAAS mode");
  if (config.authMode === "none" && !config.localhostOnly) throw new Error("Unauthenticated mode requires localhost");
  // An unconfigured instance starts in the protected administrator installer.
  // Remote setup additionally requires the one-time code printed at startup.
}
