import type { OriginalObjectStorage } from "../object-storage/originals.js";
import { createHash } from "node:crypto";
import type { SavedSourceKind, SavedSourceMetadata } from "../../shared/content-sources/contracts.js";
import { SAVED_SOURCE_LIMITS as limits } from "../../shared/content-sources/contracts.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { stableJson } from "../../shared/stable-json.js";
import type { ProjectContentView } from "../project-content/read-view.js";
import type { OwnedProjectDirectory } from "../project-content/owned-directory.js";
import { projectCreationFile, projectDocumentFile } from "../project-content/paths.js";
import { readProjectDocumentMetadata } from "../project-content/document-metadata.js";
import { ProjectContentError } from "../project-content/errors.js";
import { CreativeAssetFiles, creativeMetadata } from "../creative/assets/files.js";
import { creativeEntries } from "../creative/assets/page.js";
import { savedDocumentSources } from "./documents.js";
import { savedSourceSelection } from "./selection.js";
import type { PreparedSavedSource } from "./prepared.js";

/** Metadata discovery stays under the caller's existing authorized Git lease and never parses native originals. */
export async function savedOriginalSources(
  view: ProjectContentView,
  owned: OwnedProjectDirectory,
  assetRoot: string,
  project: string,
  kinds: readonly SavedSourceKind[] = ["document"],
  requested?: ReadonlySet<string>,
  objects?: OriginalObjectStorage,
) {
  if (owned.projectId !== project) throw new ProjectContentError("invalidFile");
  const selection = savedSourceSelection(kinds, requested),
    selectedKinds = new Set(selection.kinds),
    ids = selection.ids;
  const documents =
      selectedKinds.has("document") && (!ids || ids.size) ? await savedDocumentSources(view, project, ids) : null,
    rows = new Map<string, SavedSourceMetadata>(),
    assets = new Map<string, CreativeAsset>(),
    files = new CreativeAssetFiles(assetRoot, objects);
  let metadataBytes = 0;
  const add = (value: SavedSourceMetadata) => {
    if (rows.has(value.id)) throw new ProjectContentError("invalidFile");
    metadataBytes += Buffer.byteLength(stableJson(value));
    if (rows.size >= limits.entries || metadataBytes > limits.metadataBytes) throw new ProjectContentError("tooLarge");
    rows.set(value.id, value);
  };
  for (const identity of documents?.documents.values() ?? []) {
    if (ids && !ids.has(identity.id)) continue;
    const { document } = await readProjectDocumentMetadata(view, identity.id);
    if (document.spaceId !== identity.spaceId) throw new ProjectContentError("invalidFile");
    add({
      id: identity.id,
      version: document.revisionId,
      title: document.title,
      locale: document.locale,
      path: document.path,
      updatedAt: document.updatedAt,
      ancestors: documents!.ancestors(identity.id),
      binding: { kind: "document", path: projectDocumentFile(identity.id), blob: identity.version },
    });
  }
  if ((!ids || ids.size) && (selectedKinds.has("web") || selectedKinds.has("slides"))) {
    for (const entry of creativeEntries(view)) {
      if (ids && !ids.has(entry.id)) continue;
      const asset = await creativeMetadata(view, project, entry.id, true);
      if (
        asset.state !== "saved" ||
        (asset.kind !== "web" && asset.kind !== "slides") ||
        !selectedKinds.has(asset.kind)
      )
        continue;
      files.authorize(asset);
      assets.set(asset.id, asset);
      add({
        id: asset.id,
        version: asset.version,
        title: asset.title,
        locale: asset.locale,
        path: asset.source.name,
        updatedAt: asset.updatedAt,
        ancestors: [],
        binding: {
          kind: asset.kind,
          path: projectCreationFile(asset.id),
          blob: entry.version,
          original: { ...asset.source },
          resources: asset.resources.map((resource) => ({ ...resource })),
        },
      });
    }
  }
  const entries = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  view.assertHeld();
  async function prepare(id: string, signal?: AbortSignal): Promise<PreparedSavedSource> {
    view.assertHeld();
    const metadata = rows.get(id);
    if (!metadata) throw new ProjectContentError("notFound");
    if (signal?.aborted) throw new ProjectContentError("unavailable");
    if (metadata.binding.kind === "document") {
      const { detail, text, sections } = await documents!.read(id);
      if (detail.revision.id !== metadata.version) throw new ProjectContentError("conflict");
      view.assertHeld();
      return {
        metadata: structuredClone(metadata),
        bytes: Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(sections)),
        text: { text, sections },
      };
    }
    const asset = assets.get(id)!;
    if (asset.originalStore === "object") {
      const snapshot = await files.capture(view, owned, asset);
      return {
        metadata: structuredClone(metadata),
        bytes: asset.source.size,
        deferredNative: {
          kind: asset.kind,
          name: asset.source.name,
          read: files.deferred(snapshot),
        },
      };
    }
    const original = await files.original(view, owned, asset);
    return {
      metadata: structuredClone(metadata),
      bytes: original.bytes.byteLength,
      native: { kind: asset.kind, name: asset.source.name, bytes: original.bytes },
    };
  }
  return {
    entries: structuredClone(entries),
    head: createHash("sha256").update(stableJson(entries)).digest("hex"),
    ancestors: (id: string) => [...(rows.get(id)?.ancestors ?? [])],
    prepare,
    async verify(id: string, signal?: AbortSignal) {
      view.assertHeld();
      const metadata = rows.get(id);
      if (!metadata) throw new ProjectContentError("notFound");
      if (signal?.aborted) throw new ProjectContentError("unavailable");
      if (metadata.binding.kind !== "document") {
        const asset = assets.get(id)!;
        if (asset.originalStore === "object") await files.verifyReferences(owned, asset);
        else await files.original(view, owned, asset);
      }
      view.assertHeld();
    },
  };
}
export type SavedOriginalSources = Awaited<ReturnType<typeof savedOriginalSources>>;
