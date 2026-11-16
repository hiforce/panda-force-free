import { buildInput, safeBuildPath, BuildError } from "../../../shared/builds/validation.js";
import type { BuildInput } from "../../../shared/builds/contracts.js";
import type { SiteBuildRequest } from "../../../shared/builds/jobs.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import type { DocumentSpaceSnapshot } from "../../documents/snapshot-port.js";
import { SiteBuildError } from "../errors.js";
import { enginePreset } from "../adapters/engine-presets.js";
import { buildImageReferences } from "./references.js";
import { captureSourceProject } from "./source-project.js";
import type { BuildDocumentAssets, BuildDocumentProfile } from "./document-ports.js";
import { richBodyImageIds } from "../../../shared/documents/rich-body.js";
import { richSiteContent } from "../../../shared/documents/rich-site.js";

/** Source selection and access checks precede this shared, storage-independent build projection. */
export async function projectDocumentBuild(
  request: SiteBuildRequest,
  snapshot: DocumentSpaceSnapshot,
  theme: BuildThemeSnapshot | null,
  profile: BuildDocumentProfile | null | undefined,
  assets: BuildDocumentAssets,
) {
  const { documents: records } = snapshot;
  const preset = enginePreset(request.engine);
  const input: BuildInput = {
    protocol: 1,
    engine: request.engine,
    preset: preset.id,
    site: { title: request.title, url: request.url, basePath: request.basePath, locale: request.locale },
    documents: [],
    assets: [],
    ...(theme ? { theme } : {}),
  };
  const projection = profile
    ? await captureSourceProject(
        profile,
        records.map((selection) => ({
          id: selection.document.id,
          path: selection.path,
          revision: selection.revision,
          metadata: selection.metadata,
        })),
        assets,
      )
    : null;
  if (profile?.profile.imageMode === "source-webp" && theme !== null && theme.schema !== 2)
    throw new SiteBuildError("sourceThemeRequired");
  if (projection) input.project = projection.project;
  let bytes = records.reduce((total, value) => total + Buffer.byteLength(value.revision.content), 0);
  for (const selection of records) {
    const { document: record, revision } = selection;
    const references = revision.body
        ? {
            assets: richBodyImageIds(revision.body),
            engineSpecific: false,
            rewrite: (urls: ReadonlyMap<string, string>) => richSiteContent(revision.body!, request.engine, urls),
          }
        : buildImageReferences(revision.content, revision.resources, selection.engine),
      urls = new Map<string, string>();
    if (selection.engine !== request.engine && references.engineSpecific)
      throw new SiteBuildError("unsupportedSourceSyntax");
    for (const id of references.assets) {
      const native = projection?.documents.get(record.id)?.urls.get(id);
      if (native) {
        urls.set(id, revision.body ? request.basePath + native.replace(/^\//, "") : native);
        continue;
      }
      const owned = await assets.metadata(id);
      if (owned.documentId !== record.id) throw new SiteBuildError("assetUnavailable", 404);
      const content = await assets.content(id);
      bytes += content.bytes.length * 1.4;
      if (bytes > 30 * 1024 * 1024) throw new SiteBuildError("snapshotTooLarge", 413);
      let path: string;
      try {
        path = safeBuildPath(`${record.id}/${id}/${owned.name}`);
      } catch {
        throw new SiteBuildError("unsupportedImageReference");
      }
      input.assets.push({ path, data: content.bytes.toString("base64"), sha256: owned.digest });
      urls.set(
        id,
        preset.assetReference(
          "assets/" + path.split("/").map(encodeURIComponent).join("/"),
          request.basePath,
          revision.body ? "markup" : "markdown",
        ),
      );
    }
    const metadata = { ...(projection ? projection.documents.get(record.id)!.metadata : selection.metadata) };
    if (selection.placement && request.engine === "hexo") {
      metadata.date ??= new Date(revision.createdAt).toISOString();
      metadata.updated ??= new Date(revision.createdAt).toISOString();
    }
    input.documents.push({
      id: record.id,
      path: selection.path,
      title: typeof metadata.title === "string" ? metadata.title : revision.title,
      content: references.rewrite(urls),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  }
  try {
    return {
      input: buildInput(input),
      sources: records.map(({ document, revision, path, placement }) => ({
        id: document.id,
        path,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        ...(placement ? { sourcePath: document.path, placement } : {}),
      })),
    };
  } catch (error) {
    if (error instanceof BuildError) {
      if (error.code === "inputTooLarge") throw new SiteBuildError("snapshotTooLarge", 413);
      if (["invalidPath", "duplicatePath"].includes(error.code)) throw new SiteBuildError("unsupportedDocumentPath");
      throw new SiteBuildError("unsupportedSnapshot");
    }
    throw error;
  }
}
