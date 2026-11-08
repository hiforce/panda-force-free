import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageInfo from "../../package.json";
import { existingApplicationPath, pandaEnvironment } from "./environment.js";
import { defaultBrowseRoots } from "./path-utils.js";

// Works both from source (src/server/config.ts) and from the bundled dist/server.js.
function findProjectRoot(start: string) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "public")) && existsSync(resolve(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("Could not locate the project root containing public/");
}

const env = pandaEnvironment();
const host = env.HOST || "127.0.0.1";
const homeDir = env.HOME || process.cwd();
const codexHome = env.CODEX_HOME || join(homeDir, ".codex");
const appRoot = findProjectRoot(import.meta.dir);
const projectless = env.PANDA_FORCE_PROJECTLESS === "true";
const configuredReviewRoot = env.PANDA_FORCE_REVIEW_ROOT || null;
if (projectless && !configuredReviewRoot) {
  throw new Error("PANDA_FORCE_REVIEW_ROOT is required when PANDA_FORCE_PROJECTLESS=true");
}
const configuredDefaultCwd = resolve(
  env.PANDA_FORCE_CWD || env.PANDA_FORCE_DEFAULT_CWD || (projectless ? homeDir : appRoot),
);
const legacyAttachmentRoot = existingApplicationPath(resolve(codexHome, "panda-force-uploads"));
const attachmentRoot = resolve(env.PANDA_FORCE_ATTACHMENT_ROOT || legacyAttachmentRoot);
const stateRoot = resolve(env.PANDA_FORCE_HOME || join(homeDir, ".panda-force"));
const projectWorkspaceRoot = resolve(env.PANDA_FORCE_PROJECTS_ROOT || join(stateRoot, "projects"));
if (
  env.PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES !== undefined &&
  !["true", "false"].includes(env.PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES)
)
  throw new Error("PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES must be true or false");
const allowExternalDirectories = env.PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES !== "false";
const defaultCwd = allowExternalDirectories ? configuredDefaultCwd : projectWorkspaceRoot;
const browseRoots = allowExternalDirectories
  ? [...new Set([...defaultBrowseRoots(homeDir), projectWorkspaceRoot])]
  : [projectWorkspaceRoot];

export const config = Object.freeze({
  version: packageInfo.version,
  engineId: env.PANDA_FORCE_ENGINE || "codex",
  host,
  port: Number(env.PORT || 8899),
  localhostOnly: host === "127.0.0.1" || host === "::1" || host === "localhost",
  passwordInitialization: process.argv.includes("--setup-password"),
  accessToken: env.PANDA_FORCE_ACCESS_TOKEN || null,
  environmentPassword: env.PANDA_FORCE_PASSWORD || null,
  authMode: env.PANDA_FORCE_AUTH_MODE || null,
  appRoot,
  publicDir: resolve(appRoot, "public"),
  homeDir,
  codexHome,
  projectless,
  configuredReviewRoot,
  ntfyTopic: env.PANDA_FORCE_NTFY_TOPIC || null,
  ntfyUrl: (env.PANDA_FORCE_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
  defaultCwd,
  browseRoots,
  attachmentRoot,
  stateRoot,
  projectWorkspaceRoot,
  projectWorkspaceRootConfigured: Boolean(env.PANDA_FORCE_PROJECTS_ROOT),
  allowExternalDirectories,
  projectCatalogPath: resolve(stateRoot, "data", "projects.sqlite"),
  projectVisibilityPath: existingApplicationPath(resolve(codexHome, "panda-force-project-visibility.json")),
  defaultCodexSessionsRoot: resolve(codexHome, "sessions"),
  imageRoots: [
    ...new Set([
      ...browseRoots,
      attachmentRoot,
      legacyAttachmentRoot,
      ...(allowExternalDirectories ? [resolve(codexHome, "generated_images"), resolve(tmpdir()), resolve("/tmp")] : []),
    ]),
  ],
  fileRoots: [
    ...new Set([
      ...browseRoots,
      defaultCwd,
      ...(allowExternalDirectories ? [attachmentRoot, legacyAttachmentRoot, resolve(tmpdir()), resolve("/tmp")] : []),
    ]),
  ],
  reviewRoots: allowExternalDirectories
    ? [...new Set([resolve(configuredReviewRoot || defaultCwd), projectWorkspaceRoot])]
    : [projectWorkspaceRoot],
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
