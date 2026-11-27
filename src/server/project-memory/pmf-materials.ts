import { createHash, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import {
  memoryArchiveMaxBytes,
  memoryPackageUploadMaxBytes,
  type MemoryArchive,
} from "../../shared/project-memory/archive.js";
import {
  memoryMaterialKinds,
  memoryMaterialAnchorLimit,
  memoryMaterialCitationId,
  validMemoryMaterialAnchor,
  type MemoryPackageMaterial,
} from "../../shared/project-memory/materials.js";
import { pmfFrameBytes, pmfHeaderBytes, pmfTagBytes } from "../../shared/project-memory/pmf-envelope.js";
import { isRecord } from "../../shared/records.js";
import { SourceError } from "../../shared/packages/sources/contracts.js";
import { zipEntries, zipTrailer } from "../packages/zip/headers.js";
import { zipRangePayloads, type ZipPayload } from "../packages/zip/layout.js";
import { decodeZipPayload } from "../packages/zip/payload.js";
import { openMemoryFrames, sealMemoryFrames, type PackageRangeRead } from "./pmf-frames.js";
import { MemoryPackageError } from "./pmf.js";
import { parseMemoryArchive, validMemoryArchiveRecord } from "./portability.js";

export interface MemoryMaterialManifest {
  version: 2;
  memory: MemoryArchive;
  materials: MemoryPackageMaterial[];
}

const manifestName = "manifest.json";
const fileLimit = 32 * 1024 * 1024;
const documentsLimit = 128;
const filesLimit = 1024;
const readSize = 128 * 1024;
const date = new Date("2000-01-01T00:00:00Z");
const checksum = /^[a-f0-9]{64}$/u;
const zipLimits = {
  archiveBytes: memoryPackageUploadMaxBytes,
  fileBytes: fileLimit,
  totalBytes: memoryPackageUploadMaxBytes - 4 * pmfFrameBytes,
  entries: filesLimit + 1,
  files: filesLimit + 1,
};

const invalid = (): never => {
  throw new MemoryPackageError("projects.memoryPackageInvalid");
};
const unsupported = (): never => {
  throw new MemoryPackageError("projects.memoryPackageUnsupported");
};
const pathFor = (digest: string) => "assets/" + digest;
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= limit && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);

function versionedManifest(input: unknown) {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 3 ||
    input.version !== 2 ||
    !Array.isArray(input.materials) ||
    !input.materials.length ||
    input.materials.length > documentsLimit
  )
    return invalid();
  const memory = parseMemoryArchive(input.memory);
  const keys = new Set(memory.records.filter(validMemoryArchiveRecord).map(memoryMaterialCitationId));
  const ids = new Set<string>();
  const files = new Map<string, number>();
  const materials: MemoryPackageMaterial[] = [];
  for (const material of input.materials) {
    if (
      !isRecord(material) ||
      Object.keys(material).some(
        (key) => !["id", "title", "kind", "version", "files", "locale", "document", "anchors"].includes(key),
      ) ||
      !text(material.id, 128) ||
      !/^[\w-]{1,128}$/u.test(material.id) ||
      !text(material.title, 200) ||
      !text(material.version, 128) ||
      !memoryMaterialKinds.some((kind) => kind === material.kind) ||
      !Array.isArray(material.files) ||
      !material.files.length ||
      material.files.length > 129 ||
      ids.has(material.id)
    )
      return invalid();
    if (
      material.locale !== undefined &&
      (typeof material.locale !== "string" ||
        material.locale.length > 35 ||
        !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(material.locale))
    )
      return invalid();
    if (
      material.anchors !== undefined &&
      (!Array.isArray(material.anchors) ||
        material.anchors.length > memoryMaterialAnchorLimit ||
        !material.anchors.every(
          (anchor) => validMemoryMaterialAnchor(anchor) && keys.has(memoryMaterialCitationId(anchor)),
        ))
    )
      return invalid();
    ids.add(material.id);
    const names = new Set<string>();
    for (const file of material.files) {
      if (
        !isRecord(file) ||
        Object.keys(file).length !== 3 ||
        !text(file.name, 240) ||
        /[\\/]/u.test(file.name) ||
        file.name === "." ||
        file.name === ".." ||
        !text(file.digest, 64) ||
        !checksum.test(file.digest) ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > fileLimit ||
        names.has(file.name)
      )
        return invalid();
      if (files.has(file.digest) && files.get(file.digest) !== file.size) return invalid();
      files.set(file.digest, file.size);
      names.add(file.name);
    }
    const descriptor = material as unknown as MemoryPackageMaterial;
    if (material.document !== undefined) {
      const document = material.document;
      const resources = new Set(descriptor.files.slice(1).map((file) => file.digest));
      const sources = new Set<string>();
      if (
        material.kind !== "document" ||
        !isRecord(document) ||
        Object.keys(document).some((key) => key !== "richBody" && key !== "images") ||
        (document.richBody !== undefined &&
          (typeof document.richBody !== "string" ||
            document.richBody === descriptor.files[0]!.digest ||
            !resources.has(document.richBody))) ||
        !Array.isArray(document.images) ||
        document.images.length > 128
      )
        return invalid();
      for (const image of document.images) {
        if (
          !isRecord(image) ||
          Object.keys(image).length !== 2 ||
          !text(image.source, 2048) ||
          !text(image.digest, 64) ||
          image.digest === document.richBody ||
          !resources.has(image.digest) ||
          sources.has(image.source)
        )
          return invalid();
        sources.add(image.source);
      }
    }
    materials.push(descriptor);
  }
  if (files.size > filesLimit || [...files.values()].reduce((total, size) => total + size, 0) > zipLimits.totalBytes)
    return unsupported();
  return { memory, materials, files };
}

export function prepareMemoryMaterials(
  manifest: MemoryMaterialManifest,
  files: (digest: string) => AsyncIterable<Uint8Array>,
) {
  const { files: sizes } = versionedManifest(manifest);
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > memoryArchiveMaxBytes) return unsupported();
  // Bound both metadata overhead and the encrypted frames before any response commits.
  const maximumZip = json.length + [...sizes.values()].reduce((sum, bytes) => sum + bytes + 256, 4096);
  if (maximumZip + pmfHeaderBytes + Math.ceil(maximumZip / pmfFrameBytes) * pmfTagBytes > memoryPackageUploadMaxBytes)
    return unsupported();
  return (recipient: KeyObject) => sealMemoryFrames(recipient, writeZip(json, sizes, files));
}

async function* writeZip(
  manifest: Buffer,
  sizes: ReadonlyMap<string, number>,
  open: (digest: string) => AsyncIterable<Uint8Array>,
) {
  let pending: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    pending.push(bytes);
  });
  const drain = () => {
    const chunks = pending;
    pending = [];
    return chunks;
  };
  const entry = new ZipDeflate(manifestName, { level: 4 });
  entry.mtime = date;
  zip.add(entry);
  entry.push(manifest, true);
  yield* drain();
  for (const [digest, expected] of sizes) {
    const item = new ZipPassThrough(pathFor(digest));
    item.mtime = date;
    zip.add(item);
    const hash = createHash("sha256");
    let received = 0;
    for await (const bytes of open(digest)) {
      received += bytes.length;
      if (received > expected) return invalid();
      hash.update(bytes);
      item.push(bytes, false);
      yield* drain();
    }
    if (received !== expected || hash.digest("hex") !== digest) return invalid();
    item.push(new Uint8Array(), true);
    yield* drain();
  }
  zip.end();
  yield* drain();
}

export async function openMemoryMaterials(size: number, read: PackageRangeRead, key: Buffer) {
  const frames = await openMemoryFrames(size, read, key);
  try {
    const tail = Math.min(frames.size, 65_557);
    const trailer = zipTrailer(await frames.read(frames.size - tail, tail), frames.size);
    if (trailer.size > pmfFrameBytes) return unsupported();
    const directory = zipEntries(await frames.read(trailer.start, trailer.size), trailer, zipLimits);
    const payloads = await zipRangePayloads(frames.read, directory);
    const manifestEntry = payloads.find((entry) => entry.entry.path === manifestName);
    if (
      !manifestEntry ||
      manifestEntry.entry.directory ||
      manifestEntry.entry.expanded > memoryArchiveMaxBytes ||
      manifestEntry.entry.compressed > memoryArchiveMaxBytes + 16384
    )
      return invalid();
    const jsonBytes = await frames.read(manifestEntry.start, manifestEntry.entry.compressed);
    const json = await decodeZipPayload(jsonBytes, { ...manifestEntry, start: 0, end: jsonBytes.length });
    const manifest = versionedManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
    const entries = new Map<string, ZipPayload>();
    for (const entry of payloads) {
      if (entry === manifestEntry) continue;
      const digest = entry.entry.path.slice("assets/".length);
      if (
        entry.entry.path !== pathFor(digest) ||
        entry.entry.directory ||
        entry.entry.method !== 0 ||
        entry.entry.expanded !== entry.entry.compressed ||
        manifest.files.get(digest) !== entry.entry.expanded
      )
        return invalid();
      entries.set(digest, entry);
    }
    if (entries.size !== manifest.files.size) return invalid();

    async function* file(digest: string) {
      const item = entries.get(digest);
      if (!item) return invalid();
      const hash = createHash("sha256");
      let crc = 0;
      for (let offset = item.start; offset < item.end; offset += readSize) {
        const bytes = await frames.read(offset, Math.min(readSize, item.end - offset));
        hash.update(bytes);
        crc = crc32(bytes, crc);
        yield bytes;
      }
      if (hash.digest("hex") !== digest || crc !== item.entry.crc) return invalid();
    }

    return {
      memory: manifest.memory,
      materials: manifest.materials,
      files: manifest.files,
      async verify() {
        for (const digest of entries.keys()) for await (const bytes of file(digest)) bytes.fill(0);
      },
      file,
      close: () => frames.close(),
    };
  } catch (error) {
    frames.close();
    if (error instanceof MemoryPackageError) throw error;
    if (error instanceof SourceError && error.code === "sourceTooLarge") return unsupported();
    if (error instanceof SourceError || error instanceof SyntaxError || error instanceof TypeError) return invalid();
    throw error;
  }
}

export type OpenMemoryMaterials = Awaited<ReturnType<typeof openMemoryMaterials>>;
