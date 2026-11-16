import { stableJson } from "../../../shared/stable-json.js";
import { publicDocumentMetadata } from "../../../shared/sites/metadata.js";
import { compatibleDocumentLocale } from "../../../shared/documents/locales.js";
import { SiteProfileError } from "../../../shared/sites/config.js";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import type { ProjectDocumentSnapshots, SpaceDocumentSelection } from "../snapshot-port.js";
import { projectDocumentId } from "../../project-content/paths.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { readProjectManifest } from "../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../project-content/space-read.js";
import { decodeProjectNavigation } from "../../project-content/navigation-file.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { DocumentError } from "../errors.js";
import { localeText } from "../validation.js";
import { documentIdentity, type DocumentFileProjects } from "./projects.js";
import { filePlacements, publicationSpace } from "./placements/read.js";

const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
/** One project view freezes configuration, link policy and saved originals together; mutable drafts are never a build input. */
export class FileDocumentSnapshots implements ProjectDocumentSnapshots {
  constructor(private readonly projects: DocumentFileProjects) {}
  capture(
    projectId: string,
    spaceId: string,
    language: string,
    limits: { documents: number; bytes: number },
    expectedSpaceVersion?: number,
  ) {
    documentIdentity(spaceId);
    const locale = localeText(language),
      limit = { ...limits };
    if (
      !Number.isSafeInteger(limit.documents) ||
      limit.documents < 1 ||
      limit.documents > 500 ||
      !Number.isSafeInteger(limit.bytes) ||
      limit.bytes < 1 ||
      limit.bytes > 16 * 1024 * 1024 ||
      (expectedSpaceVersion !== undefined && (!Number.isSafeInteger(expectedSpaceVersion) || expectedSpaceVersion < 1))
    )
      throw new DocumentError("invalidInput");
    return this.projects.view(projectId, async (project, view) => {
      await publicationSpace(view, projectId, spaceId);
      const target = await project.spaces.read(view, spaceId),
        manifest = await readProjectManifest(view, projectId),
        bytes = await view.read("tree.json"),
        tree = bytes === null ? null : decodeProjectNavigation(bytes);
      if (
        tree &&
        (tree.projectId !== projectId || tree.spaces.some((state) => !manifest.spaceIds.includes(state.spaceId)))
      )
        throw new ProjectContentError("invalidFile");
      if (expectedSpaceVersion !== undefined && target.space.version !== expectedSpaceVersion)
        throw new DocumentError("spaceConflict", 409);
      const profile = target.sourceProfile;
      if (profile && !Object.keys(profile.editions).some((key) => key.toLowerCase() === locale.toLowerCase()))
        throw new DocumentError("sourceEditionMissing");
      const trash = new Set(tree?.spaces.flatMap((state) => state.trash.map((row) => row.documentId))),
        own: DocumentRecord[] = [];
      for (const path of view.paths) {
        const id = projectDocumentId(path);
        if (id === null || trash.has(id)) continue;
        const { document } = await readProjectDocumentMetadata(view, id);
        if (document.spaceId === spaceId) own.push(document);
      }
      const links = await filePlacements(view, projectId, "spaceId", spaceId);
      if (own.length + links.length > limit.documents) throw new DocumentError("tooLarge", 413);
      const documents: SpaceDocumentSelection[] = [],
        paths = new Set<string>();
      let originals = 0,
        contentBytes = 0;
      const append = async (
        record: DocumentRecord,
        revisionId: string,
        path: string,
        locale: string,
        metadata?: SpaceDocumentSelection["metadata"],
        placement?: SpaceDocumentSelection["placement"],
      ) => {
        const key = path.normalize("NFC").toLowerCase();
        if (paths.has(key)) throw new DocumentError("placementPathConflict", 409);
        paths.add(key);
        if (trash.has(record.id)) throw new DocumentError("placementSourceUnavailable", 409);
        const source = await readSpaceMetadata(view, manifest, record.spaceId),
          selected = await project.documents.selection(view, record, revisionId, MAX_ORIGINAL_BYTES - originals);
        originals += selected.fileBytes;
        contentBytes +=
          Buffer.byteLength(selected.revision.content) +
          (selected.revision.body ? Buffer.byteLength(stableJson(selected.revision.body)) : 0) +
          (metadata ? Buffer.byteLength(stableJson(metadata)) : 0) +
          (selected.revision.resources?.length ? Buffer.byteLength(stableJson(selected.revision.resources)) : 0);
        if (contentBytes > limit.bytes) throw new DocumentError("tooLarge", 413);
        if (!compatibleDocumentLocale(selected.revision.locale, locale))
          throw new DocumentError("placementLocaleMismatch", 409);
        documents.push({
          document: record,
          revision: selected.revision,
          engine: source.engine,
          path,
          locale,
          ...(metadata ? { metadata } : {}),
          ...(placement ? { placement } : {}),
        });
      };
      for (const record of own.filter((record) => record.locale.toLowerCase() === locale.toLowerCase()))
        await append(record, record.revisionId, record.path, record.locale);
      for (const link of links.filter((link) => link.locale.toLowerCase() === locale.toLowerCase())) {
        const { document } = await readProjectDocumentMetadata(view, link.documentId);
        if (document.spaceId === spaceId) throw new ProjectContentError("invalidFile");
        let metadata;
        try {
          metadata = publicDocumentMetadata(link.metadata, profile?.metadataFields);
        } catch (error) {
          if (error instanceof SiteProfileError) throw new DocumentError("invalidPlacementMetadata");
          throw error;
        }
        await append(document, link.revisionId ?? document.revisionId, link.path, link.locale, metadata, {
          id: link.id,
          version: link.version,
        });
      }
      documents.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.document.id.localeCompare(b.document.id, "en"),
      );
      return { projectId, commit: view.commit, space: target.space, profile, documents };
    });
  }
}
