import { join } from "node:path";
import type { MetadataStore } from "../../../../shared/async-value.js";
import type { DocumentSpace } from "../../../../shared/documents/contracts.js";
import type { SiteThemeCatalog } from "../../../../shared/presentation/themes.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { ProjectGitSnapshots } from "../../../project-content/git/snapshot.js";
import { projectSpaceFile } from "../../../project-content/paths.js";
import { readProjectManifest } from "../../../project-content/project-manifest.js";
import type { ProjectContentProject } from "../../../project-content/project.js";
import { decodeProjectSpace } from "../../../project-content/space-file.js";
import { readSpaceMetadata } from "../../../project-content/space-read.js";
import { DocumentError } from "../../errors.js";
import type { DocumentSourceReader } from "../../source-reader.js";
import type { DocumentSpaceConfiguration, ProjectDocumentSpaces } from "../../space-port.js";
import { text } from "../../validation.js";
import { documentAuthor, editorInput } from "../commands.js";
import { documentIdentity, type DocumentFileProjects } from "../projects.js";
import { configuredTheme, createSpaceCommand, spaceEdits } from "./commands.js";

async function configurationAt(
  project: ProjectContentProject,
  commit: string,
  id: string,
): Promise<DocumentSpaceConfiguration> {
  const bytes = await new ProjectGitSnapshots(project.owned).fileAt(commit, projectSpaceFile(id));
  if (bytes === null) throw new DocumentError("unavailable", 503);
  const value = decodeProjectSpace(bytes);
  return { space: value.space, profile: value.sourceProfile };
}

/** Publication configuration owns metadata only; it cannot build engines, publish articles or mutate imported source directories. */
export class FileDocumentSpaces implements ProjectDocumentSpaces {
  constructor(
    private readonly projects: DocumentFileProjects,
    private readonly sources: DocumentSourceReader,
    private readonly themes: MetadataStore<SiteThemeCatalog>,
  ) {}
  async list(projectId: string) {
    return (
      (await this.projects.ifPresent(projectId, async (_project, view) => {
        const manifest = await readProjectManifest(view, projectId),
          result: DocumentSpace[] = [];
        for (const id of manifest.spaceIds)
          if (id !== manifest.librarySpaceId) result.push(await readSpaceMetadata(view, manifest, id));
        return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en"));
      })) ?? []
    );
  }
  async get(projectId: string, spaceId: string): Promise<DocumentSpaceConfiguration> {
    documentIdentity(spaceId);
    return this.projects.view(projectId, async (project, view) => {
      const value = await project.spaces.read(view, spaceId);
      return { space: value.space, profile: value.sourceProfile };
    });
  }
  async inspect(projectId: string, value: unknown) {
    const path = text(editorInput(value, ["path"]).path, 4096);
    await this.projects.authorize(projectId);
    const result = await this.sources.inspect(path);
    await this.projects.authorize(projectId);
    return result;
  }
  async create(actor: string, value: unknown) {
    const command = createSpaceCommand(value),
      input = command.input,
      author = documentAuthor(actor);
    await this.projects.authorize(input.projectId);
    return this.projects.initialize(input.projectId, async (project) => {
      const result = await project.coordinator.plan(
        {
          operationId: command.operationId,
          author,
          message: "Create project publication space",
          intent: stableJson({ schema: 1, kind: "space-create", input }),
        },
        async (view) => {
          let external: string | undefined;
          if (input.sourceMode === "external") {
            const inspection = await this.sources.inspect(input.sourceRoot!);
            if (inspection.engine !== input.engine) throw new DocumentError("invalidInput");
            external = inspection.root;
          }
          const now = Date.now(),
            space: DocumentSpace = {
              id: command.operationId,
              ...input,
              theme: await configuredTheme(this.themes, input.theme, input.engine),
              sourceRoot: external ?? join(project.owned.directory, "documents"),
              version: 1,
              createdAt: now,
              updatedAt: now,
            };
          return {
            changes: await project.spaces.prepare(view, { schema: 1, space, sourceProfile: null }, null, "publication"),
          };
        },
      );
      return (await configurationAt(project, result.commit, command.operationId)).space;
    });
  }
  async configure(actor: string, projectId: string, spaceId: string, value: unknown) {
    documentIdentity(spaceId);
    const command = spaceEdits(value),
      author = documentAuthor(actor);
    return this.projects.write(projectId, async (project) => {
      const result = await project.coordinator.plan(
        {
          operationId: command.operationId,
          author,
          message: "Configure project document space",
          intent: stableJson({ schema: 1, kind: "space-configure", projectId, spaceId, command }),
        },
        async (view) => {
          const current = await project.spaces.read(view, spaceId),
            manifest = await readProjectManifest(view, projectId);
          if (current.space.version !== command.version) throw new DocumentError("spaceConflict", 409);
          const profile = command.profile === undefined ? current.sourceProfile : command.profile;
          if (
            profile &&
            (profile.engine !== current.space.engine ||
              (current.space.sourceMode === "managed" && profile.resources.length))
          )
            throw new DocumentError("invalidSourceConfiguration");
          const space = {
            ...current.space,
            name: command.name ?? current.space.name,
            theme:
              command.theme === undefined
                ? current.space.theme
                : await configuredTheme(this.themes, command.theme, current.space.engine),
          };
          if (
            stableJson(space) === stableJson(current.space) &&
            stableJson(profile) === stableJson(current.sourceProfile)
          )
            return { changes: [] };
          space.version++;
          space.updatedAt = Math.max(Date.now(), space.updatedAt);
          return {
            changes: await project.spaces.prepare(
              view,
              { schema: 1, space, sourceProfile: profile },
              command.version,
              manifest.librarySpaceId === spaceId ? "library" : "publication",
            ),
          };
        },
      );
      return configurationAt(project, result.commit, spaceId);
    });
  }
}
