import { stableJson } from "../../shared/stable-json.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { ProjectContentError } from "./errors.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import type { ProjectContentView } from "./read-view.js";
import { decodeProjectLanguages, encodeProjectLanguages, type ProjectLanguageFile } from "./language-file.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import { readProjectManifest } from "./project-manifest.js";
import { contentRequestHash } from "./mutation.js";
import { projectContentId } from "./paths.js";

/** Translation identity is file metadata; locale edits do not silently merge, unlink or rewrite source documents. */
export class ProjectLanguageFiles {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }
  private decode(bytes: Buffer | null): ProjectLanguageFile {
    const value: ProjectLanguageFile =
      bytes === null
        ? { schema: 1, projectId: this.owned.projectId, version: 0, groups: [] }
        : decodeProjectLanguages(bytes);
    if (value.projectId !== this.owned.projectId) throw new ProjectContentError("invalidFile");
    return value;
  }
  private async members(view: ProjectContentView, ids: readonly string[]) {
    const manifest = await readProjectManifest(view, this.owned.projectId),
      result: DocumentRecord[] = [];
    for (const id of ids) {
      const { document } = await readProjectDocumentMetadata(view, id);
      if (!manifest.spaceIds.includes(document.spaceId)) throw new ProjectContentError("invalidFile");
      result.push(document);
    }
    if (result.some((doc) => doc.spaceId !== result[0]?.spaceId)) throw new ProjectContentError("invalidFile");
    return result;
  }
  async list(documentId: string) {
    projectContentId(documentId);
    return this.coordinator.view(async (view) => {
      const file = this.decode(await view.read("languages.json")),
        group = file.groups.find((group) => group.documentIds.includes(documentId));
      return (await this.members(view, group?.documentIds ?? [documentId])).sort(
        (a, b) => a.locale.localeCompare(b.locale, "en") || a.id.localeCompare(b.id, "en"),
      );
    });
  }
  private async change(
    documentId: string,
    otherId: string | null,
    operationId: string,
    author: ContentAuthor,
  ): Promise<ProjectLanguageFile> {
    projectContentId(documentId);
    if (otherId !== null && projectContentId(otherId) === documentId) throw new ProjectContentError("invalidFile");
    const result = await this.coordinator.transact(
      {
        operationId,
        author,
        message: "Update document language relationships",
        intent: stableJson({ schema: 1, kind: "language-relationship", documentId, otherId }),
      },
      async (view) => {
        const file = this.decode(await view.read("languages.json")),
          first = file.groups.find((group) => group.documentIds.includes(documentId));
        await this.members(view, [documentId]);
        if (otherId === null) {
          if (!first) return [];
          return [
            {
              path: "languages.json",
              content: encodeProjectLanguages({
                ...file,
                version: file.version + 1,
                groups: file.groups
                  .map((group) =>
                    group.id === first.id
                      ? { ...group, documentIds: group.documentIds.filter((id) => id !== documentId) }
                      : group,
                  )
                  .filter((group) => group.documentIds.length),
              }),
            },
          ];
        }
        const second = file.groups.find((group) => group.documentIds.includes(otherId)),
          ids = [...new Set([...(first?.documentIds ?? [documentId]), ...(second?.documentIds ?? [otherId])])].sort(),
          members = await this.members(view, ids),
          locales = new Set<string>();
        for (const doc of members) {
          if (locales.has(doc.locale.toLowerCase())) throw new ProjectContentError("conflict");
          locales.add(doc.locale.toLowerCase());
        }
        if (first && second && first.id === second.id) return [];
        const id = first?.id ?? second?.id ?? "language-" + contentRequestHash({ operationId });
        const groups = file.groups.filter((group) => group.id !== first?.id && group.id !== second?.id);
        groups.push({ id, documentIds: ids });
        groups.sort((a, b) => a.id.localeCompare(b.id, "en"));
        return [
          { path: "languages.json", content: encodeProjectLanguages({ ...file, version: file.version + 1, groups }) },
        ];
      },
    );
    return this.decode(await this.snapshots.fileAt(result.commit, "languages.json"));
  }
  link(documentId: string, otherId: string, operationId: string, author: ContentAuthor) {
    return this.change(documentId, otherId, operationId, author);
  }
  unlink(documentId: string, operationId: string, author: ContentAuthor) {
    return this.change(documentId, null, operationId, author);
  }
}
