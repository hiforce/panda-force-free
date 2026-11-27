import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, basename } from "node:path";
import type {
  MemoryMaterialSelection,
  MemoryMaterialExportSelection,
  MemoryMaterialCatalogItem,
  MemoryPackageMaterial,
} from "../../shared/project-memory/materials.js";
import {
  memoryMaterialKinds,
  memoryMaterialCitationKind,
  memoryMaterialAnchorLimit,
  validMemoryMaterialAnchor,
  type MemoryMaterialAnchor,
} from "../../shared/project-memory/materials.js";
import { isRecord } from "../../shared/records.js";
import { stableJson } from "../../shared/stable-json.js";
import { richBodyImageIds } from "../../shared/documents/rich-body.js";
import { assetContentUrl } from "../../shared/documents/syntax/images.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import type { FileCreativeAssetReader } from "../creative/assets/reader.js";
import type { FileDocumentQueries } from "../documents/files/queries.js";
import type { FileDocumentAssets } from "../documents/files/assets.js";
import { storeDocumentBlob } from "../documents/blob-store.js";
import { namespace } from "./records.js";
import type { MemoryMaterialPreviewSource } from "./material-previews.js";
import type { OpenMemoryMaterials } from "./pmf-materials.js";

export const memoryMaterialLimit = 128;
const versionId = /^[\w-]{1,128}$/u;
const digestId = /^[a-f0-9]{64}$/u;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const materialDigest = (materials: MemoryPackageMaterial[]) => sha(stableJson(materials));

type NativeSources = {
  creations: FileCreativeAssetReader;
  queries: Pick<FileDocumentQueries, "record" | "detail" | "savedRecords">;
  assets: Pick<FileDocumentAssets, "content" | "metadata">;
};
type Readable = { material: MemoryPackageMaterial; read(digest: string): Promise<Uint8Array> };

const conflict = (): never => {
  throw new HarnessError("conflict", 409);
};
const unavailable = (): never => {
  throw new HarnessError("notFound", 404);
};
const normalizeLabel = (value: string, fallback: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .trim()
    .slice(0, 200) || fallback;
const fileName = (value: string) => normalizeLabel(basename(value.replaceAll("\\", "/")), "document.md");
const descriptor = (row: { id: string; version: string; title: string; kind: string }) => ({
  id: row.id,
  version: row.version,
  title: normalizeLabel(row.title, row.id),
  kind: row.kind as MemoryMaterialSelection["kind"],
});

function catalogItem(row: Omit<MemoryMaterialCatalogItem, "citation">): MemoryMaterialCatalogItem {
  return { ...descriptor(row), source: row.source, citation: memoryMaterialCitationKind(row.kind, row.source) };
}

function documentFileName(title: string) {
  const name = normalizeLabel(title.replace(/[<>:"/\\|?*]/gu, "-"), "document");
  return name.toLowerCase().endsWith(".md") ? name : name + ".md";
}

export function materialSelection(input: unknown): MemoryMaterialExportSelection[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > memoryMaterialLimit) throw new HarnessError("invalidInput");
  const seen = new Set<string>();
  return input.map((row) => {
    if (
      !isRecord(row) ||
      Object.keys(row).some((key) => !["id", "version", "kind", "anchors"].includes(key)) ||
      typeof row.id !== "string" ||
      !versionId.test(row.id) ||
      typeof row.version !== "string" ||
      !versionId.test(row.version) ||
      !memoryMaterialKinds.some((kind) => kind === row.kind) ||
      seen.has(row.id)
    )
      throw new HarnessError("invalidInput");
    seen.add(row.id);
    const { anchors } = row;
    if (
      anchors !== undefined &&
      (!Array.isArray(anchors) ||
        anchors.length > memoryMaterialAnchorLimit ||
        !anchors.every(validMemoryMaterialAnchor))
    )
      throw new HarnessError("invalidInput");
    return row as unknown as MemoryMaterialExportSelection;
  });
}

export class MemoryMaterialStore {
  constructor(
    private readonly root: string,
    private readonly source: (owner: string) => NativeSources,
  ) {}

  async catalog(owner: string, project: string, type: "document" | "files", cursor?: string) {
    const native = this.source(owner);
    if (type === "files") {
      const page = await native.creations.list(project, cursor);
      return {
        items: page.assets.flatMap((asset) =>
          asset.kind === "web" ? [] : [catalogItem({ ...asset, kind: asset.kind, source: asset.source.name })],
        ),
        cursor: page.nextCursor,
      };
    }
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new HarnessError("invalidInput");
    const page = await native.queries.savedRecords(project, offset);
    return {
      items: page.documents.map((doc) =>
        catalogItem({ ...doc, kind: "document", version: doc.revisionId, source: documentFileName(doc.title) }),
      ),
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  }

  private async resolve(owner: string, project: string, selected: MemoryMaterialSelection): Promise<Readable> {
    const native = this.source(owner);
    if (selected.kind === "document") {
      const { document, revision } = await native.queries.detail(project, selected.id);
      if (revision.id !== selected.version) return conflict();
      const text = Buffer.from(revision.content);
      const original = { name: documentFileName(document.title), digest: sha(text), size: text.length };
      const attachments = new Map<string, string>();
      const resources: MemoryPackageMaterial["files"] = [original];
      const bindings = new Map<string, string>();
      const revisionImages = new Map((revision.resources ?? []).map((item) => [item.source, item]));
      if (revision.body) {
        for (const assetId of richBodyImageIds(revision.body)) {
          const source = assetContentUrl(assetId);
          if (!revisionImages.has(source)) revisionImages.set(source, { source, sourcePath: "", assetId, digest: "" });
        }
      }
      for (const { source, sourcePath, assetId, digest: expected } of revisionImages.values()) {
        const asset = await native.assets.metadata(project, assetId);
        const { digest } = asset;
        if (asset.documentId !== document.id || (expected && expected !== digest)) return conflict();
        if (digest === original.digest) continue;
        bindings.set(source, digest);
        if (attachments.has(digest)) continue;
        const raw = fileName(sourcePath || asset.name);
        let name = raw;
        while (resources.some((item) => item.name === name)) name = digest.slice(0, 12) + "-" + name;
        attachments.set(digest, assetId);
        resources.push({ name, digest, size: asset.size });
      }
      const body = revision.body ? Buffer.from(JSON.stringify(revision.body)) : undefined;
      const richBody = body ? sha(body) : undefined;
      if (richBody && body) {
        let name = "editable-document.pfrich";
        while (resources.some((item) => item.name === name)) name = "-" + name;
        resources.push({ name, digest: richBody, size: body.length });
      }
      return {
        material: {
          ...descriptor({ ...selected, title: document.title }),
          files: resources,
          locale: revision.locale,
          ...(richBody || bindings.size
            ? { document: { richBody, images: [...bindings].map(([source, digest]) => ({ source, digest })) } }
            : {}),
        },
        async read(digest) {
          if (body && digest === richBody) return body;
          if (digest === original.digest) {
            const current = await native.queries.detail(project, selected.id);
            if (current.revision.id !== selected.version) return conflict();
            return Buffer.from(current.revision.content);
          }
          const id = attachments.get(digest);
          if (!id) return unavailable();
          return (await native.assets.content(project, id)).bytes;
        },
      };
    }
    const { asset } = await native.creations.resource(project, selected.id, {
      version: selected.version,
      select: () => ({ head: true }),
    });
    if (asset.kind !== selected.kind) return conflict();
    return {
      material: { ...descriptor(asset), locale: asset.locale, files: [asset.source, ...asset.resources] },
      async read(digest) {
        const resource = [asset.source, ...asset.resources].find((item) => item.digest === digest);
        if (!resource) return unavailable();
        const { bytes } = await native.creations.resource(project, asset.id, {
          version: asset.version,
          name: resource === asset.source ? undefined : resource.name,
        });
        return bytes ?? unavailable();
      },
    };
  }

  private previewSource(owner: string, project: string, source: Readable): MemoryMaterialPreviewSource {
    const {
      id,
      version,
      kind,
      files: [file],
    } = source.material;
    return {
      identity: ["native", owner, project, id, version],
      kind,
      file: file!,
      read: () => source.read(file!.digest),
      verify: () => this.assertCurrent(owner, project, source.material),
    };
  }

  async preview(owner: string, project: string, selection: MemoryMaterialSelection) {
    return this.previewSource(owner, project, await this.resolve(owner, project, selection));
  }

  async exportMaterials(
    owner: string,
    project: string,
    selected: MemoryMaterialExportSelection[],
    validate: (source: MemoryMaterialPreviewSource, anchors: readonly MemoryMaterialAnchor[]) => Promise<void>,
  ) {
    const ready: MemoryPackageMaterial[] = [];
    const sources = new Map<string, Readable>();
    for (const item of selected) {
      const source = await this.resolve(owner, project, item);
      if (item.anchors?.length) {
        await validate(this.previewSource(owner, project, source), item.anchors);
        source.material.anchors = item.anchors;
      }
      ready.push(source.material);
      for (const file of source.material.files) if (!sources.has(file.digest)) sources.set(file.digest, source);
    }
    return {
      materials: ready,
      async *read(digest: string) {
        const source = sources.get(digest);
        if (!source) return unavailable();
        yield await source.read(digest);
      },
    };
  }

  async assertCurrent(owner: string, project: string, material: MemoryMaterialSelection) {
    const native = this.source(owner);
    if (material.kind === "document") {
      const record = await native.queries.record(project, material.id);
      if (record.revisionId !== material.version) return conflict();
    } else {
      await native.creations.resource(project, material.id, {
        version: material.version,
        select: () => ({ head: true }),
      });
    }
  }

  private directory(owner: string, project: string, checksum: string) {
    if (!digestId.test(checksum)) return unavailable();
    return join(this.root, namespace(owner, project).slice(3), checksum);
  }

  async save(owner: string, project: string, material: OpenMemoryMaterials) {
    const directory = this.directory(owner, project, materialDigest(material.materials));
    for (const [digest, size] of material.files) {
      const collected = Buffer.alloc(size);
      let offset = 0;
      for await (const chunk of material.file(digest)) {
        collected.set(chunk, offset);
        offset += chunk.length;
      }
      if (offset !== size) return unavailable();
      await storeDocumentBlob(directory, digest, collected);
    }
  }

  async read(owner: string, project: string, checksum: string, digest: string, size: number) {
    if (!digestId.test(digest)) return unavailable();
    const file = await open(
      join(this.directory(owner, project, checksum), digest),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== size) return unavailable();
      const bytes = await file.readFile();
      if (sha(bytes) !== digest) return unavailable();
      return bytes;
    } finally {
      await file.close();
    }
  }
}
