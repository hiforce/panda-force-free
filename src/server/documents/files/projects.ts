import { createOwnedProjectDirectory, findOwnedProjectDirectory } from "../../project-content/owned-directory.js";
import { ProjectContentProject } from "../../project-content/project.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { decodeProjectLegacyImport } from "../../project-content/migration/import-file.js";
import { readProjectManifest } from "../../project-content/project-manifest.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { DocumentError } from "../errors.js";
import { documentFileOperation } from "./errors.js";

export type DocumentProjectReads = Pick<DocumentFileProjects, "authorize" | "ifPresent">;

export function documentIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new DocumentError("invalidInput");
  return value;
}

async function ready(project: ProjectContentProject, view: ProjectContentView) {
  const bytes = await view.read("import.json");
  if (bytes !== null) {
    const imported = decodeProjectLegacyImport(bytes);
    if (imported.projectId !== project.owned.projectId) throw new ProjectContentError("invalidFile");
    if (imported.state !== "complete") throw new ProjectContentError("unavailable");
  }
  await readProjectManifest(view, project.owned.projectId);
}

/** Only explicitly addressed, authorized repositories are opened. Reads never create roots or discover private projects. */
export class DocumentFileProjects {
  private readonly owners = new Map<string, Promise<ProjectContentProject | null>>();
  constructor(
    private readonly root: string,
    private readonly requireProject: (projectId: string) => unknown | Promise<unknown>,
    private readonly changed?: (projectId: string) => void,
    private readonly authorizeUnderLease?: (projectId: string) => void | Promise<void>,
  ) {}
  async authorize(projectId: string): Promise<void> {
    documentIdentity(projectId);
    await this.requireProject(projectId);
  }

  private async owner(projectId: string, initialize = false): Promise<ProjectContentProject> {
    documentIdentity(projectId);
    await this.requireProject(projectId);
    let owner = this.owners.get(projectId);
    if (!owner) {
      owner = (async () => {
        const owned = initialize
          ? await createOwnedProjectDirectory(this.root, projectId)
          : await findOwnedProjectDirectory(this.root, projectId);
        return owned === null ? null : new ProjectContentProject(owned, () => this.authorizeUnderLease?.(projectId));
      })();
      this.owners.set(projectId, owner);
    }
    try {
      const project = await owner;
      if (project === null) {
        if (this.owners.get(projectId) === owner) this.owners.delete(projectId);
        // An overlapping read miss cannot satisfy an explicit creation; reauthorize before its independent attempt.
        if (initialize) return this.owner(projectId, true);
        throw new DocumentError("notFound", 404);
      }
      // Recheck after asynchronous opening, including cache hits; ownership never grants application authorization.
      await this.requireProject(projectId);
      return project;
    } catch (error) {
      if (this.owners.get(projectId) === owner) this.owners.delete(projectId);
      throw error;
    }
  }

  async view<T>(projectId: string, work: (project: ProjectContentProject, view: ProjectContentView) => Promise<T>) {
    return documentFileOperation(async () => {
      const project = await this.owner(projectId);
      return project.coordinator.view(async (view) => {
        await ready(project, view);
        await this.requireProject(projectId);
        const result = await work(project, view);
        await this.requireProject(projectId);
        view.assertHeld();
        return result;
      });
    });
  }
  async ifPresent<T>(
    projectId: string,
    work: (project: ProjectContentProject, view: ProjectContentView) => Promise<T>,
  ): Promise<T | null> {
    return documentFileOperation(async () => {
      documentIdentity(projectId);
      await this.requireProject(projectId);
      const owned = await findOwnedProjectDirectory(this.root, projectId);
      await this.requireProject(projectId);
      return owned === null ? null : this.view(projectId, work);
    });
  }

  /** Mutations retain the same owner and revalidate source/generation under its write lease. */
  async write<T>(projectId: string, work: (project: ProjectContentProject) => Promise<T>) {
    return documentFileOperation(async () => {
      const project = await this.view(projectId, async (owner) => owner);
      await this.requireProject(projectId);
      const result = await work(project);
      this.changed?.(projectId);
      return result;
    });
  }
  /** Only an explicit creation command may initialize a dedicated owned content directory. */
  async initialize<T>(projectId: string, work: (project: ProjectContentProject) => Promise<T>) {
    return documentFileOperation(async () => {
      const project = await this.owner(projectId, true);
      await project.coordinator.view(async (view) => ready(project, view));
      await this.requireProject(projectId);
      const result = await work(project);
      this.changed?.(projectId);
      return result;
    });
  }
}
