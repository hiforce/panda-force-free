import { basename } from "node:path";
import type { DocumentEngine, DocumentImportIssue } from "../../../shared/documents/contracts.js";
import { documentImageSources } from "../../../shared/documents/syntax/images.js";
import { readSourceBytes } from "./files.js";
import { imageCandidates } from "./image-paths.js";
import { MAX_ASSET_BYTES, type DocumentAssets } from "../assets.js";
import { DocumentError } from "../errors.js";
import { createHash } from "node:crypto";
import { localizedImageCandidates, companionWebp, type SourceImagePolicy } from "../source-profile/image-policy.js";

export interface StagedImage {
  source: string;
  sourcePath: string;
  asset: Awaited<ReturnType<DocumentAssets["stage"]>>;
}
export interface ImportBudget {
  bytes: number;
  seen?: Map<string, string>;
  staged?: Map<string, Awaited<ReturnType<DocumentAssets["stage"]>>>;
}
/** Collect only explicitly referenced local images. Missing references remain visible in the report. */
export class DocumentImageIngestion {
  constructor(private assets: Pick<DocumentAssets, "stage">) {}
  async verify(root: string, groups: Iterable<StagedImage[]>) {
    const seen = new Map<string, string>();
    for (const images of groups)
      for (const image of images) {
        const previous = seen.get(image.sourcePath);
        if (previous && previous !== image.asset.digest) throw new DocumentError("conflict", 409);
        if (!previous) {
          const bytes = await readSourceBytes(root, image.sourcePath, MAX_ASSET_BYTES);
          if (createHash("sha256").update(bytes).digest("hex") !== image.asset.digest)
            throw new DocumentError("conflict", 409);
          seen.set(image.sourcePath, image.asset.digest);
        }
      }
  }
  async stage(
    root: string,
    document: string,
    content: string,
    engine: DocumentEngine,
    budget: ImportBudget,
    policy?: SourceImagePolicy,
  ) {
    const images: StagedImage[] = [],
      issues: DocumentImportIssue[] = [];
    const sources = [...new Set([...documentImageSources(content, engine), ...(policy?.metadataSources || [])])];
    budget.seen ||= new Map();
    budget.staged ||= new Map();
    let bytes = 0;
    const read = async (path: string) => {
      const data = await readSourceBytes(root, path, MAX_ASSET_BYTES),
        digest = createHash("sha256").update(data).digest("hex"),
        prior = budget.seen!.get(path);
      bytes += data.length;
      if (prior && prior !== digest) throw new DocumentError("conflict", 409);
      if (!prior) {
        budget.bytes += data.length;
        budget.seen!.set(path, digest);
      }
      return { path, data, digest };
    };
    const stage = async (path: string, data: Buffer, digest: string) => {
      const key = digest + ":" + basename(path);
      if (!budget.staged!.has(key)) budget.staged!.set(key, await this.assets.stage(basename(path), data));
      return budget.staged!.get(key)!;
    };
    for (const [index, source] of sources.entries()) {
      if (/^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/i.test(source)) continue;
      const issue = (code: DocumentImportIssue["code"]) =>
        issues.push({ path: document, source: source.slice(0, 2048), code });
      if (index >= 64 || bytes >= 32 * 1024 * 1024 || budget.bytes >= 128 * 1024 * 1024) {
        issue("imageLimit");
        break;
      }
      const candidates = imageCandidates(document, source, engine);
      if (!candidates.length) {
        issue(/^https?:|^\/\//i.test(source) ? "imageExternal" : "imageUnsupported");
        continue;
      }
      const found: { path: string; data: Buffer; digest: string }[] = [];
      let unavailable = false;
      for (const path of candidates) {
        for (const variant of policy ? localizedImageCandidates(path, policy.suffixes) : [path]) {
          try {
            found.push(await read(variant));
            break;
          } catch (error) {
            if (error instanceof DocumentError && error.code === "conflict") throw error;
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
              unavailable = true;
              break;
            }
          }
        }
      }
      if (unavailable) {
        issue("imageUnavailable");
        continue;
      }
      if (!found.length) {
        issue("imageMissing");
        continue;
      }
      if (new Set(found.map((item) => item.digest)).size !== 1) {
        issue("imageAmbiguous");
        continue;
      }
      if (bytes > 32 * 1024 * 1024 || budget.bytes > 128 * 1024 * 1024) {
        issue("imageLimit");
        break;
      }
      const file = found[0]!;
      try {
        const entries: StagedImage[] = [
          { source, sourcePath: file.path, asset: await stage(file.path, file.data, file.digest) },
        ];
        if (policy?.webp && companionWebp(file.path) !== file.path) {
          let companion;
          try {
            companion = await read(companionWebp(file.path));
          } catch (error) {
            if (error instanceof DocumentError && error.code === "conflict") throw error;
            issue(
              error instanceof Error && "code" in error && error.code === "ENOENT"
                ? "imageMissing"
                : "imageUnavailable",
            );
            continue;
          }
          if (bytes > 32 * 1024 * 1024 || budget.bytes > 128 * 1024 * 1024) {
            issue("imageLimit");
            break;
          }
          entries.push({
            source: "/" + companion.path,
            sourcePath: companion.path,
            asset: await stage(companion.path, companion.data, companion.digest),
          });
        }
        for (const entry of entries) if (!images.some((prior) => prior.source === entry.source)) images.push(entry);
      } catch (error) {
        if (
          !(error instanceof DocumentError) ||
          !["invalidImage", "assetTooLarge", "invalidInput"].includes(error.code)
        )
          throw error;
        issue("imageUnsupported");
      }
    }
    return { images, issues };
  }
}
