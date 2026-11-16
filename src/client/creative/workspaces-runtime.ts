import { createProjectDocumentsView } from "../projects/documents-view.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { createCreativeWorkspace, type ContentProject } from "./workspace.js";
import { createSkillsWorkspace } from "./skills.js";
import { createPublishWorkspace } from "./publish.js";
import type { createLazyTemplateManager } from "../templates/lazy-settings.js";
import type { ProjectReadAhead } from "./read-ahead.js";
import type { ComposerMount } from "../../gadget/system/composer/host.js";

/** Optional content routes share code, while each mounted workspace owns its requests and dialogs. */
export function createContentWorkspace(
  kind: "create" | "project" | "directory" | "skills" | "publish",
  t: Translate,
  identity: string,
  projects: () => ContentProject[],
  navigate: (path: string) => void,
  manager?: ReturnType<typeof createLazyTemplateManager>,
  readAhead?: ProjectReadAhead,
  composer?: ComposerMount,
) {
  if (kind === "directory") return createProjectDocumentsView(t, projects, navigate);
  if (kind === "skills") return createSkillsWorkspace(t, navigate, manager!);
  if (kind === "publish") return createPublishWorkspace(t, projects, navigate, manager!);
  if (!composer) throw new Error("A registered composer provider is required");
  return createCreativeWorkspace(
    t,
    identity,
    projects,
    navigate,
    composer,
    kind === "project" ? "project" : "personal",
    readAhead,
  );
}
