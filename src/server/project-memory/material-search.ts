import type { MemoryMaterialHit, MemoryMaterialSearchPage } from "../../shared/project-memory/materials.js";
import { memoryMaterialAnchorSupported, memoryMaterialOriginals } from "../../shared/project-memory/materials.js";
import { SEARCH_LIMITS, type SearchDocument } from "../../shared/search/contracts.js";
import { creativeFileExtension, creativeFilePreview } from "../../shared/creative/file-types.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { MaterialTextWorkers } from "../materials/workers.js";
import { MaterialTextError } from "../materials/contracts.js";
import { ImageTextRecognizer, imageTextRevision, isRasterTextSource } from "../materials/image-text.js";
import type { TextIndexProvider } from "../search/ports.js";
import { indexedMemoryVersion, memorySearchAnalyzer } from "./search-documents.js";
import { ProjectMemorySearch } from "./search-index.js";
import type { MemoryMaterialStore } from "./materials.js";
import {
  archiveImportKey,
  archiveImportKind,
  type MemoryArchiveReceipt,
  type MemoryArchiveAuthorize,
} from "./portability.js";
import { digest, namespace } from "./records.js";
import { memoryControlPattern, memoryCredentialPattern } from "./rules.js";

type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type Location = NonNullable<MemoryMaterialHit["location"]>;
type Work = {
  owner: string;
  project: string;
  packageId: string;
  checksum: string;
  file: number;
  attempts: number;
  imageOnly?: true;
  ocrRevision?: number;
};
type FileRef = Omit<MemoryMaterialHit, "location" | "excerpt">;
type Section = { text: string; location?: Location; recognition?: "ocr" };
type Projection = FileRef & {
  checksum: string;
  version: string;
  sections: Section[];
  cues: Array<{ key: string; scope: string; location: Location }>;
};
export type MaterialCandidates = Awaited<ReturnType<ProjectMemorySearch["lookup"]>>;
const jobKind = "memory-material-work";
const completeKind = "memory-material-complete";
const fileKind = "memory-material-projection";
const fileKey = (id: string) => fileKind + ":" + id;
const jobKey = (bucket: string, id: string) => jobKind + ":" + digest([bucket, id]);
const fileId = (bucket: string, ref: FileRef) =>
  digest([bucket, ref.packageId, ref.material.id, ref.file.digest, ref.file.name]);
const bound = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.replaceAll("\t", " "))
    .filter((line) => !memoryControlPattern.test(line) && !memoryCredentialPattern.test(line))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
const filesOf = (receipt: MemoryArchiveReceipt) =>
  (receipt.materials ?? []).flatMap((material) =>
    memoryMaterialOriginals(material).map((file): FileRef => {
      const { id, version, title, kind } = material;
      return { packageId: receipt.packageId, file, material: { id, version, title, kind } };
    }),
  );
const matches = (text: string, terms: ReadonlySet<string>) =>
  new Set(memorySearchAnalyzer.tokens(text).filter((term) => terms.has(term))).size;
function excerpt(text: string, terms: ReadonlySet<string>) {
  const offset =
    [...text.matchAll(/\S+/gu)].find((word) => memorySearchAnalyzer.tokens(word[0]).some((term) => terms.has(term)))
      ?.index ?? 0;
  return text.slice(Math.max(0, offset - 100), Math.max(0, offset - 100) + 420);
}

async function putJob(
  tx: HarnessMetadataTransaction,
  id: string,
  bucket: string,
  job: Work,
  previous: HarnessRecord | null,
  updatedAt: number,
  complete = false,
) {
  await tx.put(
    {
      id,
      owner: bucket,
      kind: complete ? completeKind : jobKind,
      revision: (previous?.revision ?? 0) + 1,
      data: JSON.stringify(job),
      updatedAt,
    },
    previous?.revision ?? null,
  );
}

/** Imported text is indexed on the application host. File bytes and extracted terms never go to the external provider. */
export class ProjectMemoryMaterialSearch {
  private readonly index: ProjectMemorySearch;
  private readonly workers = new MaterialTextWorkers(1);
  private readonly ocr = new ImageTextRecognizer();
  private readonly checked = new Map<string, Promise<void>>();
  private processing?: Promise<void>;
  private closing = false;
  constructor(
    private readonly metadata: HarnessMetadata,
    local: TextIndexProvider,
    private readonly store: Pick<MemoryMaterialStore, "read">,
    private readonly authorize: MemoryArchiveAuthorize,
    private readonly now: () => number = Date.now,
  ) {
    this.index = new ProjectMemorySearch(
      metadata,
      { local },
      (owner, project, salt) => this.snapshot(owner, project, salt),
      now,
      "materials",
    );
  }
  async enqueue(
    tx: HarnessMetadataTransaction,
    owner: string,
    project: string,
    receipt: MemoryArchiveReceipt,
    ocr = false,
    rebuild = false,
  ) {
    if (receipt.withdrawn || !receipt.materialDigest || !receipt.materials?.length) return;
    const bucket = namespace(owner, project);
    const id = jobKey(bucket, receipt.packageId);
    const previous = await tx.get(id);
    const upgrade =
      ocr &&
      previous?.kind === completeKind &&
      (rebuild || decode<Work>(previous)!.ocrRevision !== imageTextRevision) &&
      filesOf(receipt).some(({ file }) => isRasterTextSource(file.name));
    if (!previous || upgrade)
      await putJob(
        tx,
        id,
        bucket,
        {
          owner,
          project,
          packageId: receipt.packageId,
          checksum: receipt.materialDigest,
          file: 0,
          attempts: 0,
          ...(upgrade ? { imageOnly: true } : {}),
        },
        previous,
        this.now(),
      );
  }
  async withdraw(tx: HarnessMetadataTransaction, owner: string, project: string, receipt: MemoryArchiveReceipt) {
    if (!receipt.materialDigest) return;
    const bucket = namespace(owner, project);
    const job = await tx.get(jobKey(bucket, receipt.packageId));
    if (job) await tx.remove(job.id, job.revision);
    let removed = false;
    for (const file of filesOf(receipt)) {
      const row = await tx.get(fileKey(fileId(bucket, file)));
      if (row) {
        await tx.remove(row.id, row.revision);
        removed = true;
      }
    }
    if (removed) await this.index.dirty(tx, owner, project);
  }
  private ensure(owner: string, project: string, rebuild = false) {
    const bucket = namespace(owner, project);
    let existing = this.checked.get(bucket);
    if (!existing || rebuild) {
      existing = this.ocr
        .language()
        .then((language) =>
          this.metadata.transaction(async (tx) => {
            for (const row of await tx.list(archiveImportKind, bucket)) {
              const receipt = decode<MemoryArchiveReceipt>(row)!;
              await this.enqueue(tx, owner, project, receipt, !!language, rebuild);
            }
          }),
        )
        .catch((error: unknown) => {
          this.checked.delete(bucket);
          throw error;
        });
      if (this.checked.size >= 256) this.checked.delete(this.checked.keys().next().value!);
      this.checked.set(bucket, existing);
    }
    return existing;
  }
  wake() {
    if (this.closing) return;
    this.index.wake();
    this.processing ??= this.process()
      .catch(() => {})
      .finally(() => {
        this.processing = undefined;
      });
  }
  async close() {
    this.closing = true;
    this.ocr.close();
    await this.workers.close();
    await Promise.all([this.index.close(), this.processing]);
  }
  private async process() {
    for (let step = 0; step < 6 && !this.closing; step++) {
      const [row] = await this.metadata.list(jobKind, undefined, {
        limit: 1,
        oldestFirst: true,
        updatedThrough: this.now(),
      });
      if (!row) return;
      const job = decode<Work>(row)!;
      const leased = await this.metadata.transaction(async (tx) => {
        if ((await tx.get(row.id))?.revision !== row.revision) return false;
        await putJob(tx, row.id, row.owner, job, row, this.now() + 45_000);
        return true;
      });
      if (!leased) continue;
      const { owner, project } = job;
      const receiptId = archiveImportKey(row.owner, job.packageId);
      try {
        await this.authorize(owner, project, "read");
        const receipt = decode<MemoryArchiveReceipt>(await this.metadata.read(receiptId));
        const file =
          receipt && !receipt.withdrawn && receipt.materialDigest === job.checksum
            ? filesOf(receipt)[job.file]
            : undefined;
        const language = await this.ocr.language();
        const projection =
          file && (!job.imageOnly || (language && isRasterTextSource(file.file.name)))
            ? await this.capture(job, receipt!, file, language)
            : undefined;
        await this.authorize(owner, project, "read");
        await this.metadata.transaction(async (tx) => {
          const lease = await tx.get(row.id);
          if (!lease || lease.revision !== row.revision + 1) return;
          const current = decode<MemoryArchiveReceipt>(await tx.get(receiptId));
          if (!current || current.withdrawn || current.materialDigest !== job.checksum) {
            await tx.remove(lease.id, lease.revision);
            return;
          }
          const fileIndex = job.file + 1,
            files = filesOf(current);
          const complete = !file || fileIndex >= files.length;
          const ocrRevision =
            language && (job.file === 0 || job.ocrRevision === imageTextRevision) ? imageTextRevision : undefined;
          const catchup = !!(
            complete &&
            language &&
            !ocrRevision &&
            !job.imageOnly &&
            files.some(({ file }) => isRasterTextSource(file.name))
          );
          if (projection) await save(tx, fileKey(fileId(row.owner, projection)), fileKind, row.owner, projection);
          await putJob(
            tx,
            lease.id,
            row.owner,
            {
              ...job,
              file: catchup ? 0 : fileIndex,
              imageOnly: catchup ? true : job.imageOnly,
              ocrRevision,
              attempts: 0,
            },
            lease,
            this.now(),
            complete && !catchup,
          );
          if (complete && files.length) await this.index.dirty(tx, owner, project);
        });
      } catch {
        await this.metadata.transaction(async (tx) => {
          const lease = await tx.get(row.id);
          if (!lease || lease.revision !== row.revision + 1) return;
          const attempts = Math.min(job.attempts + 1, 10);
          await putJob(
            tx,
            lease.id,
            row.owner,
            { ...job, attempts },
            lease,
            this.now() + Math.min(60_000, 1000 * 2 ** attempts),
          );
        });
      }
    }
  }
  private async capture(
    job: Work,
    receipt: MemoryArchiveReceipt,
    file: FileRef,
    language?: string,
  ): Promise<Projection> {
    const { name, digest: checksum, size } = file.file;
    const material = receipt.materials!.find((item) => item.id === file.material.id)!;
    const extension = creativeFileExtension(name);
    const office = ["pptx", "pdf", "docx", "xlsx"].includes(extension);
    const plain = creativeFilePreview(name).kind === "text";
    const sections: Section[] = [];
    const image = !!language && isRasterTextSource(name);
    if (plain || office || image) {
      const bytes = await this.store.read(job.owner, job.project, job.checksum, checksum, size);
      if (image && language) {
        for (const { text, region } of await this.ocr.read(bytes, language, material.locale)) {
          const recognized = bound(text);
          if (recognized)
            sections.push({
              text: recognized.slice(0, 1200),
              location: { kind: "image", ...region },
              recognition: "ocr",
            });
        }
      } else if (office) {
        try {
          const source = await this.workers.readSections(name, bytes);
          for (const [index, offset] of source.offsets.entries()) {
            const text = bound(source.text.slice(offset, source.offsets[index + 1]));
            for (let start = 0; start < text.length; start += 1050) {
              sections.push({
                text: text.slice(start, start + 1200),
                ...(extension === "pdf" || extension === "pptx"
                  ? { location: { kind: extension === "pdf" ? "page" : "slide", number: index + 1 } }
                  : {}),
              });
            }
          }
        } catch (error) {
          if (!(error instanceof MaterialTextError) || error.code === "busy") throw error;
        }
      } else {
        const source = new TextDecoder().decode(bytes.subarray(0, 128 * 1024));
        for (const paragraph of source.split(/\r?\n\s*\r?\n/u).slice(0, 160)) {
          const text = bound(paragraph);
          for (let start = 0; start < text.length; start += 1050)
            sections.push({ text: text.slice(start, start + 1200) });
        }
      }
    }
    const cues =
      material.files[0]?.digest === checksum
        ? (material.anchors ?? []).filter((anchor) => memoryMaterialAnchorSupported(material, anchor))
        : [];
    // Keep a bounded, replaceable local projection. The protected original is retained independently.
    const selected: Section[] = [];
    let total = 0;
    for (const part of sections) {
      total += Buffer.byteLength(part.text);
      if (total > 96 * 1024) break;
      selected.push(part);
    }
    return {
      ...file,
      checksum: job.checksum,
      version: digest(["material/1", job.checksum, file, selected, cues]),
      sections: selected,
      cues,
    };
  }
  private async snapshot(owner: string, project: string, salt: string): Promise<SearchDocument[]> {
    await this.authorize(owner, project, "read");
    const bucket = namespace(owner, project);
    const rows = await this.metadata.list(fileKind, bucket, { limit: SEARCH_LIMITS.documents + 1 });
    let size = 0;
    return rows.map((row) => {
      const record = decode<Projection>(row)!;
      const text = [
        ...record.cues.map(({ key, scope }) => key + " " + scope),
        ...record.sections.map(({ text }) => text),
      ].join(" ");
      size += Buffer.byteLength(text);
      if (size > SEARCH_LIMITS.textBytes) throw new Error("Project material index text limit");
      return {
        id: fileId(bucket, record),
        title: bound(record.material.title + " " + record.file.name),
        text,
        version: indexedMemoryVersion(salt, record.version),
        updatedAt: 0,
        locale: "und",
        path: "",
        ancestors: [],
      };
    });
  }
  async lookup(owner: string, project: string, query: string, wait?: number): Promise<MaterialCandidates> {
    await this.ensure(owner, project);
    const jobs = await this.metadata.list(jobKind, namespace(owner, project), { limit: 1 });
    const indexed = await this.metadata.list(fileKind, namespace(owner, project), { limit: 1 });
    if (!indexed.length) return { hits: new Map(), available: !jobs.length };
    return this.index.lookup(owner, project, query, wait);
  }
  async current(owner: string, project: string, id: string, reader: Reader) {
    const bucket = namespace(owner, project);
    const row = await reader.get(fileKey(id));
    if (row?.owner !== bucket) return null;
    const file = decode<Projection>(row)!;
    const receipt = decode<MemoryArchiveReceipt>(await reader.get(archiveImportKey(bucket, file.packageId)));
    return receipt && !receipt.withdrawn && receipt.materialDigest === file.checksum ? file : null;
  }
  async results(
    owner: string,
    project: string,
    query: string,
    candidates: MaterialCandidates,
    reader: Reader,
    limit: number,
    exclude: (id: string, version: string) => boolean = () => false,
  ) {
    const result: Array<MemoryMaterialHit & { id: string; version: string }> = [];
    if (!candidates.salt) return result;
    const terms = new Set(memorySearchAnalyzer.tokens(query.slice(0, 800)));
    const seen = new Set<string>();
    for (const [id, version] of candidates.hits) {
      const file = await this.current(owner, project, id, reader);
      if (!file || indexedMemoryVersion(candidates.salt, file.version) !== version || exclude(id, file.version))
        continue;
      const identity = digest([file.material.version, file.file.digest]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const best = file.sections
        .map((section) => ({ section, score: matches(section.text, terms) }))
        .sort((left, right) => right.score - left.score)[0];
      const cue = file.cues.find(({ key, scope }) => matches(key + " " + scope, terms) > 0);
      const part = best && best.score ? best.section : undefined;
      const location = part?.location ?? cue?.location;
      result.push({
        id,
        version: file.version,
        packageId: file.packageId,
        material: file.material,
        file: file.file,
        ...(location ? { location } : {}),
        ...(part ? { excerpt: excerpt(part.text, terms) } : {}),
        ...(part?.recognition ? { recognition: part.recognition } : {}),
      });
      if (result.length >= limit) break;
    }
    return result;
  }
  async rebuild(owner: string, project: string) {
    await this.ensure(owner, project, true);
    await this.index.ensure(owner, project, true);
    this.wake();
  }
  async find(owner: string, project: string, query: string, reader: Reader): Promise<MemoryMaterialSearchPage> {
    const found = await this.lookup(owner, project, query, 1000);
    const job = (await this.metadata.list(jobKind, namespace(owner, project), { limit: 1 }))[0];
    return {
      state: job
        ? decode<Work>(job)!.attempts >= 4
          ? "unavailable"
          : "pending"
        : found.available
          ? "ready"
          : (await this.index.status(owner, project)).state,
      hits: await this.results(owner, project, query, found, reader, 20),
    };
  }
}
