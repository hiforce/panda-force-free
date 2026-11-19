import type { DocumentProjectReads } from "../../documents/files/projects.js";
import { documentFileOperation } from "../../documents/files/errors.js";
import { DocumentError } from "../../documents/errors.js";
import type { OriginalObjectStorage } from "../../object-storage/originals.js";
import { CreativeAssetFiles, creativeMetadata } from "./files.js";
import { creativePage } from "./page.js";
import type { CreativeAsset, CreativeAssetDetail } from "../../../shared/creative/assets.js";
import { creativeFilePreview } from "../../../shared/creative/file-types.js";
import { projectCreationFile } from "../../project-content/paths.js";
import { extractCreativeText } from "./projection.js";

/** Optional personal reads do not initialize roots, upload directories or creation/engine workers. */
export class FileCreativeAssetReader {
  protected readonly files: CreativeAssetFiles;
  constructor(
    private readonly reads: DocumentProjectReads,
    assetRoot: string,
    private readonly parse = extractCreativeText,
    objects?: OriginalObjectStorage,
  ) {
    this.files = new CreativeAssetFiles(assetRoot, objects);
  }
  authorize(project: string) {
    return this.reads.authorize(project);
  }
  list(project: string, cursor?: string, state: CreativeAsset["state"] = "saved") {
    return documentFileOperation(async () => {
      const page = await this.reads.ifPresent(project, (_p, view) => creativePage(view, project, cursor, state));
      if (!page && cursor) throw new DocumentError("conflict", 409);
      for (const asset of page?.assets ?? []) this.files.authorize(asset);
      return page ?? { assets: [], nextCursor: null };
    });
  }
  private check(signal?: AbortSignal) {
    if (signal?.aborted) throw new DocumentError("unavailable", 503);
  }
  private async metadata(project: string, id: string) {
    const value = await this.reads.ifPresent(project, async (owner, view) => ({
      owner,
      asset: await creativeMetadata(view, project, id),
      commit: view.commit,
      blob: view.version(projectCreationFile(id))!,
    }));
    if (!value) throw new DocumentError("notFound", 404);
    this.files.authorize(value.asset);
    return value;
  }
  private async capture(project: string, id: string) {
    const value = await this.reads.ifPresent(project, async (owner, view) => ({
      snapshot: await this.files.capture(view, owner.owned, await creativeMetadata(view, project, id)),
      commit: view.commit,
      blob: view.version(projectCreationFile(id))!,
    }));
    if (!value) throw new DocumentError("notFound", 404);
    return value;
  }
  private async verify(project: string, id: string, blob: string, signal?: AbortSignal, localBytes = false) {
    this.check(signal);
    const result = await this.reads.ifPresent(project, async (owner, view) => {
      const asset = await creativeMetadata(view, project, id);
      if (view.version(projectCreationFile(id)) !== blob) throw new DocumentError("conflict", 409);
      if (localBytes && asset.originalStore !== "object") await this.files.original(view, owner.owned, asset);
      this.check(signal);
      return true;
    });
    if (!result) throw new DocumentError("notFound", 404);
    await this.reads.authorize(project);
    this.check(signal);
  }
  original(project: string, id: string, signal?: AbortSignal) {
    return documentFileOperation(async () => {
      this.check(signal);
      const captured = await this.capture(project, id),
        original = await this.files.load(captured.snapshot, signal);
      await this.verify(project, id, captured.blob, signal);
      return { ...original, commit: captured.commit };
    });
  }
  /** Native browser viewers need identity metadata, not a duplicate full binary download and parse. */
  detail(project: string, id: string, signal?: AbortSignal): Promise<CreativeAssetDetail> {
    return documentFileOperation(async () => {
      this.check(signal);
      const value = await this.metadata(project, id),
        preview = creativeFilePreview(value.asset.source.name);
      if (["image", "video"].includes(value.asset.kind) || (value.asset.kind === "file" && preview.kind !== "text")) {
        await this.verify(project, id, value.blob, signal);
        return { asset: value.asset, text: "", sections: [] };
      }
      return this.read(project, id, signal, true);
    });
  }
  /** Select exact remote ranges before IO and fence the metadata again after transfer. */
  async delivery(
    project: string,
    id: string,
    options: {
      name?: string;
      version: string;
      signal?: AbortSignal;
      attachment?: boolean;
      select?: (asset: CreativeAsset, resource: CreativeAsset["source"]) => { head?: boolean };
    },
  ) {
    return documentFileOperation(async () => {
      this.check(options.signal);
      const value = await this.metadata(project, id),
        asset = value.asset,
        resource = options.name === undefined ? asset.source : asset.resources.find((row) => row.name === options.name);
      if (options.version !== asset.version) throw new DocumentError("conflict", 409);
      if (!resource) throw new DocumentError("notFound", 404);
      const preview = creativeFilePreview(resource.name),
        attachment = options.attachment ?? (["web", "slides"].includes(asset.kind) || preview.kind === "download");
      if (!attachment && (["web", "slides"].includes(asset.kind) || preview.kind === "download"))
        throw new DocumentError("invalidInput");
      const selected = options.select?.(asset, resource);
      if (selected?.head || asset.originalStore !== "object") return null;
      const link = await this.files.delivery(
        value.owner.owned,
        asset,
        resource,
        attachment,
        attachment ? "application/octet-stream" : preview.mime,
      );
      await this.verify(project, id, value.blob, options.signal);
      return link;
    });
  }

  /** Select exact remote ranges before IO and fence the metadata again after transfer. */
  resource(
    project: string,
    id: string,
    options: {
      name?: string;
      version?: string;
      signal?: AbortSignal;
      select?: (
        asset: CreativeAsset,
        resource: CreativeAsset["source"],
      ) => { head?: boolean; range?: { start: number; end: number } };
    } = {},
  ) {
    return documentFileOperation(async () => {
      this.check(options.signal);
      const captured = await this.capture(project, id),
        asset = captured.snapshot.asset,
        resource = options.name === undefined ? asset.source : asset.resources.find((row) => row.name === options.name);
      if (options.version !== undefined && options.version !== asset.version) throw new DocumentError("conflict", 409);
      if (!resource) throw new DocumentError("notFound", 404);
      const selected = options.select?.(asset, resource) ?? {},
        bytes = selected.head
          ? undefined
          : await this.files.resource(captured.snapshot, options.name, options.signal, selected.range);
      await this.verify(project, id, captured.blob, options.signal);
      return { asset, resource, bytes };
    });
  }
  read(project: string, id: string, signal?: AbortSignal, preview = false) {
    return documentFileOperation(async () => {
      this.check(signal);
      const captured = await this.capture(project, id),
        original = await this.files.load(captured.snapshot, signal);
      this.check(signal);
      const projection = await this.parse(
        original.asset.kind,
        original.asset.source.name,
        original.bytes,
        signal,
        preview,
        preview ? original.resources : [],
      );
      await this.verify(project, id, captured.blob, signal, true);
      return { ...original, commit: captured.commit, ...projection };
    });
  }
}
