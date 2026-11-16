import type { DocumentProjectReads } from "../../documents/files/projects.js";
import { documentFileOperation } from "../../documents/files/errors.js";
import { DocumentError } from "../../documents/errors.js";
import { CreativeAssetFiles, creativeMetadata } from "./files.js";
import { creativePage } from "./page.js";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import { projectCreationFile } from "../../project-content/paths.js";
import { extractCreativeText } from "./projection.js";

/** Optional personal reads do not initialize roots, upload directories or creation/engine workers. */
export class FileCreativeAssetReader {
  protected readonly files: CreativeAssetFiles;
  constructor(
    private readonly reads: DocumentProjectReads,
    assetRoot: string,
    private readonly parse = extractCreativeText,
  ) {
    this.files = new CreativeAssetFiles(assetRoot);
  }
  authorize(project: string) {
    return this.reads.authorize(project);
  }
  list(project: string, cursor?: string, state: CreativeAsset["state"] = "saved") {
    return documentFileOperation(async () => {
      const page = await this.reads.ifPresent(project, (_p, view) => creativePage(view, project, cursor, state));
      if (!page && cursor) throw new DocumentError("conflict", 409);
      return page ?? { assets: [], nextCursor: null };
    });
  }
  original(project: string, id: string) {
    return documentFileOperation(async () => {
      const result = await this.reads.ifPresent(project, async (owner, view) => ({
        ...(await this.files.original(view, owner.owned, await creativeMetadata(view, project, id))),
        commit: view.commit,
      }));
      if (!result) throw new DocumentError("notFound", 404);
      return result;
    });
  }
  read(project: string, id: string, signal?: AbortSignal, preview = false) {
    return documentFileOperation(async () => {
      const check = () => {
        if (signal?.aborted) throw new DocumentError("unavailable", 503);
      };
      check();
      await this.reads.authorize(project);
      const captured = await this.reads.ifPresent(project, async (owner, view) => ({
        ...(await this.files.original(view, owner.owned, await creativeMetadata(view, project, id))),
        commit: view.commit,
        blob: view.version(projectCreationFile(id)),
      }));
      if (!captured) throw new DocumentError("notFound", 404);
      check();
      const projection = await this.parse(
        captured.asset.kind,
        captured.asset.source.name,
        captured.bytes,
        signal,
        preview,
        preview ? captured.resources : [],
      );
      check();
      await this.reads.authorize(project);
      const verified = await this.reads.ifPresent(project, async (owner, view) => {
        if (view.version(projectCreationFile(id)) !== captured.blob) throw new DocumentError("conflict", 409);
        await this.files.original(view, owner.owned, await creativeMetadata(view, project, id));
        check();
        return true;
      });
      if (!verified) throw new DocumentError("notFound", 404);
      await this.reads.authorize(project);
      check();
      return {
        asset: captured.asset,
        bytes: captured.bytes,
        resources: captured.resources,
        commit: captured.commit,
        ...projection,
      };
    });
  }
}
