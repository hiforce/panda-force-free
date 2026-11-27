import { randomUUID } from "node:crypto";
import { HarnessError } from "../../shared/harness/contracts.js";
import {
  memoryArchiveFormat,
  memoryArchiveId,
  memoryArchiveMaxBytes,
  memoryArchiveMaxRecords,
  memoryArchiveVersion,
  type MemoryArchive,
  type MemoryArchiveEntry,
  type MemoryArchiveImport,
  type MemoryArchivePreview,
} from "../../shared/project-memory/archive.js";
import type { MemoryMaterialSelection } from "../../shared/project-memory/materials.js";
import { isRecord } from "../../shared/records.js";
import { digest, entryId, type MemoryEvidence } from "./records.js";
import { memoryControlPattern, memoryCredentialPattern, memoryKey } from "./rules.js";

export const archiveGrantKind = "project-memory-export";
export const archiveImportKind = "project-memory-import";
export const archiveGrantKey = (id: string) => "memory-export:" + id;
export const archiveImportKey = (bucket: string, id: string) => "memory-import:" + digest([bucket, id]);

export type MemoryArchiveAuthorize = (owner: string, project: string, access?: "read" | "contribute") => Promise<void>;

export interface MemoryArchiveGrant {
  owner: string;
  project: string;
  checksum: string;
  materialDigest?: string;
  sources?: MemoryMaterialSelection[];
}

export interface MemoryArchiveReceipt extends MemoryArchiveImport {
  checksum: string;
  materialDigest?: string;
}

export function importSummary({
  checksum: _checksum,
  materialDigest: _materialDigest,
  ...summary
}: MemoryArchiveReceipt): MemoryArchiveImport {
  return summary;
}

type ArchiveHeader = Omit<MemoryArchive, "records" | "checksum">;
type ImportInput = ArchiveHeader & { records: unknown[]; checksum: string };
const maxClaims = 1_000;
const claimCount = (records: unknown[]) =>
  records.reduce<number>(
    (sum, item) => sum + (isRecord(item) && Array.isArray(item.values) ? item.values.length : 0),
    0,
  );

function checksum({ format, version, packageId, createdAt, records }: Omit<ImportInput, "checksum">) {
  const stableRecords = records.map((row) =>
    isRecord(row) && Object.keys(row).length === 3 ? [row.key, row.scope, row.values] : row,
  );
  return digest([format, version, packageId, createdAt, stableRecords]);
}

export function validMemoryArchiveRecord(row: unknown): row is MemoryArchiveEntry {
  if (!isRecord(row) || Object.keys(row).length !== 3) return false;
  const { key, scope, values } = row;
  if (
    typeof key !== "string" ||
    typeof scope !== "string" ||
    !/^[\p{L}\p{M}\p{N}-]{1,80}$/u.test(key) ||
    !/^[\p{L}\p{M}\p{N}-]{1,48}$/u.test(scope) ||
    key !== memoryKey(key) ||
    scope !== memoryKey(scope) ||
    !Array.isArray(values) ||
    !values.length ||
    values.length > memoryArchiveMaxRecords
  )
    return false;
  return values.every(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 240 &&
      value === value.trim() &&
      !memoryControlPattern.test(value) &&
      !memoryCredentialPattern.test([key, scope, value].join(" ")),
  );
}

export function parseMemoryArchive(input: unknown): ImportInput {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 6 ||
    input.format !== memoryArchiveFormat ||
    input.version !== memoryArchiveVersion ||
    typeof input.packageId !== "string" ||
    !memoryArchiveId.test(input.packageId) ||
    typeof input.createdAt !== "number" ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt <= 0 ||
    !Array.isArray(input.records) ||
    input.records.length > memoryArchiveMaxRecords ||
    claimCount(input.records) > maxClaims ||
    typeof input.checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.checksum)
  )
    throw new HarnessError("invalidInput");
  const archive = input as ImportInput;
  if (checksum(archive) !== archive.checksum) throw new HarnessError("invalidInput");
  return archive;
}

export function archiveRecords(groups: ReadonlyMap<string, MemoryEvidence[]>): MemoryArchiveEntry[] {
  return [...groups.values()]
    .flatMap((rows) => {
      const { key, scope } = rows[0]!;
      const record = { key, scope, values: [...new Set(rows.map(({ value }) => value))].sort() };
      return validMemoryArchiveRecord(record) ? [record] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope));
}

export function createMemoryArchive(records: MemoryArchiveEntry[], createdAt: number): MemoryArchive {
  const payload = {
    format: memoryArchiveFormat,
    version: memoryArchiveVersion,
    packageId: randomUUID(),
    createdAt,
    records,
  } as const;
  const archive = { ...payload, checksum: checksum(payload) };
  if (
    records.length > memoryArchiveMaxRecords ||
    claimCount(records) > maxClaims ||
    Buffer.byteLength(JSON.stringify(archive)) + 1024 > memoryArchiveMaxBytes
  )
    throw new HarnessError("contextTooLarge", 413);
  return archive;
}

export function assertArchiveOrigin(archive: ImportInput, current: MemoryArchiveEntry[]) {
  const valid = new Map(current.map((row) => [entryId(row.key, row.scope), digest(row.values)]));
  if (
    archive.records.some(
      (row) => !validMemoryArchiveRecord(row) || valid.get(entryId(row.key, row.scope)) !== digest(row.values),
    )
  )
    throw new HarnessError("conflict", 409);
}

export function prepareArchiveImport(
  bucket: string,
  archive: ImportInput,
  groups: ReadonlyMap<string, MemoryEvidence[]>,
  receipt?: MemoryArchiveReceipt,
) {
  const preview: MemoryArchivePreview = {
    packageId: archive.packageId,
    token: "",
    added: 0,
    duplicate: 0,
    conflict: 0,
    invalid: 0,
    imported: Boolean(receipt),
    withdrawn: receipt?.withdrawn ?? false,
    records: [],
  };
  const input = new Map<string, MemoryArchiveEntry>();
  for (const row of archive.records) {
    if (!validMemoryArchiveRecord(row)) {
      preview.invalid++;
      continue;
    }
    const id = entryId(row.key, row.scope);
    const prior = input.get(id);
    if (prior) prior.values.push(...row.values);
    else input.set(id, { key: row.key, scope: row.scope, values: [...row.values] });
  }
  const changes: MemoryArchiveEntry[] = [];
  const revisions: string[][] = [];
  for (const [id, row] of input) {
    const values = [...new Set(row.values)].sort();
    const current = groups.get(id) ?? [];
    const existing = new Set(current.map(({ value }) => value));
    revisions.push([id, ...current.map(({ id: sourceId }) => sourceId).sort()]);
    const newValues = values.filter((value) => !existing.has(value));
    const action =
      receipt || !newValues.length ? "duplicate" : new Set([...existing, ...values]).size > 1 ? "conflict" : "added";
    preview[action]++;
    preview.records.push({ ...row, values, action });
    if (action !== "duplicate") changes.push({ ...row, values: newValues });
  }
  preview.token = digest([bucket, archive.checksum, revisions, receipt?.withdrawn ?? null]);
  return { preview, changes };
}
