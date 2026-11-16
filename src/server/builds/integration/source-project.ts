import type { DocumentRevision } from "../../../shared/documents/contracts.js";
import type { PublicDocumentMetadata } from "../../../shared/sites/metadata.js";
import type { SiteSourceProfile } from "../../../shared/sites/profile.js";
import type { BuildProjectSnapshot } from "../../../shared/builds/project.js";
import type { BuildDocumentAssets, BuildDocumentProfile } from "./document-ports.js";
import { sourceMetadata } from "../../documents/source-profile/yaml.js";
import { sourceImagePolicy, companionWebp } from "../../documents/source-profile/image-policy.js";
import { SiteBuildError } from "../errors.js";
import { richProjectImages } from "./rich-project-images.js";

function resourceRule(profile: SiteSourceProfile, source: string) {
  return [...profile.resources]
    .sort((a, b) => b.directory.length - a.directory.length)
    .find((rule) => source.startsWith(rule.directory + "/"));
}
export function resourceTarget(profile: SiteSourceProfile, source: string): string | undefined {
  const root = resourceRule(profile, source);
  return root ? root.target + source.slice(root.directory.length) : undefined;
}
/** Revision-owned optimized images override current project files; the host cannot replace historical pixels. */
export async function captureSourceProject(
  snapshot: BuildDocumentProfile,
  records: { id: string; path: string; revision: DocumentRevision; metadata?: PublicDocumentMetadata }[],
  assets: BuildDocumentAssets,
) {
  const project: BuildProjectSnapshot = {
      schema: 1,
      engine: "hexo",
      config: snapshot.edition.config,
      files: snapshot.files,
      ...(snapshot.profile.metadataFields ? { metadataFields: snapshot.profile.metadataFields } : {}),
    },
    files = new Map(project.files.map((file) => [file.path.normalize("NFC").toLowerCase(), file])),
    bound = new Map<string, string>();
  const documents = new Map<string, { metadata: ReturnType<typeof sourceMetadata>; urls: Map<string, string> }>();
  let size = project.files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0);
  const put = (file: BuildProjectSnapshot["files"][number]) => {
    const key = file.path.normalize("NFC").toLowerCase();
    size += Buffer.byteLength(file.data) - Buffer.byteLength(files.get(key)?.data || "");
    if (size > 30 * 1024 * 1024 || (!files.has(key) && files.size >= 500))
      throw new SiteBuildError("snapshotTooLarge", 413);
    files.set(key, file);
  };
  for (const { id, path, revision, metadata: overrides } of records) {
    const metadata = {
        ...(revision.body ? {} : sourceMetadata(revision.content, snapshot.profile.metadataFields)),
        ...overrides,
      },
      urls = new Map<string, string>();
    if (snapshot.profile.imageMode === "source-webp" && revision.body) {
      for await (const image of richProjectImages(id, revision, metadata.cover, assets)) {
        const old = files.get(image.file.path.normalize("NFC").toLowerCase());
        if (old && (old.path !== image.file.path || old.sha256 !== image.file.sha256))
          throw new SiteBuildError("sourceResourceConflict", 409);
        put(image.file);
        urls.set(image.id, image.url);
        if (image.cover) metadata.cover = image.url;
      }
    } else if (snapshot.profile.imageMode === "source-webp") {
      const coverSource = sourceImagePolicy(snapshot.profile, revision.locale, revision.content)?.metadataSources[0];
      for (const binding of revision.resources || []) {
        const target = resourceTarget(snapshot.profile, binding.sourcePath);
        if (!target) throw new SiteBuildError("sourceImageRuleMissing");
        const companion = (revision.resources || []).find(
          (item) => item.sourcePath === companionWebp(binding.sourcePath),
        );
        if (!companion) throw new SiteBuildError("sourceImageCompanionMissing");
        const image = await assets.content(companion.assetId),
          primary = await assets.metadata(binding.assetId);
        if (
          image.asset.documentId !== id ||
          primary.documentId !== id ||
          primary.digest !== binding.digest ||
          image.asset.digest !== companion.digest ||
          image.asset.mime !== "image/webp"
        )
          throw new SiteBuildError("assetUnavailable");
        const rule = resourceRule(snapshot.profile, companion.sourcePath),
          path = resourceTarget(snapshot.profile, companion.sourcePath);
        if (!path || !rule?.extensions.includes("webp")) throw new SiteBuildError("sourceImageRuleMissing");
        const key = path.normalize("NFC").toLowerCase(),
          prior = bound.get(key);
        if (prior && prior !== image.asset.digest) throw new SiteBuildError("sourceResourceConflict", 409);
        if (files.get(key)?.path && files.get(key)!.path !== path)
          throw new SiteBuildError("sourceResourceConflict", 409);
        bound.set(key, image.asset.digest);
        put({
          path,
          data: image.bytes.toString("base64"),
          sha256: image.asset.digest,
          publish: rule.publish,
        });
        urls.set(binding.assetId, "/" + target.split("/").map(encodeURIComponent).join("/"));
        if (binding.source === coverSource) metadata.cover = "/" + target;
      }
      if (coverSource && !revision.resources?.some((item) => item.source === coverSource))
        throw new SiteBuildError("sourceImageCompanionMissing");
    }
    // A source edition may contain pages and drafts as well as posts; preserve those distinctions.
    if (path.split("/").includes("_drafts")) metadata.published = false;
    documents.set(id, { metadata, urls });
  }
  project.files = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  if (size > 30 * 1024 * 1024 || project.files.length > 500) throw new SiteBuildError("snapshotTooLarge", 413);
  return { project, documents };
}
