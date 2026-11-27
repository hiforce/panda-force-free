import { basename } from "node:path";
import { CREATIVE_ASSET_LIMITS } from "../../shared/creative/assets.js";
import { richBodyImageIds } from "../../shared/documents/rich-body.js";
import { assetContentUrl } from "../../shared/documents/syntax/images.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import type { MemoryArchiveImport } from "../../shared/project-memory/archive.js";
import {
  memoryMaterialOriginals,
  type MemoryMaterialFile,
  type MemoryMaterialNativeCopy,
  type MemoryPackageMaterial,
} from "../../shared/project-memory/materials.js";
import type { CreativeSaveInput } from "../creative/assets/prepare.js";
import type { FileCreativeAssets } from "../creative/assets/service.js";
import type { PreparedDocumentCreation } from "../documents/creation-port.js";
import { DocumentError } from "../documents/errors.js";
import type { FileDocumentNavigation } from "../documents/files/navigation/service.js";
import { richDocumentFromMarkdown, richDocumentInput } from "../documents/rich-codec.js";
import { MAX_DOCUMENT_BYTES } from "../documents/validation.js";
import type { HarnessMetadata } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { digest, namespace } from "./records.js";

const copyKind = "project-memory-native-copy";
const sourceIdentity = (material: MemoryPackageMaterial) =>
  digest([
    material.kind,
    material.id,
    material.version,
    material.title,
    material.locale ?? "en",
    material.files.map(({ name, digest, size }) => [name, digest, size]),
    material.document?.images.map(({ source, digest }) => [source, digest]),
  ]);
const copyKey = (bucket: string, id: string) => "memory-native-copy:" + digest([bucket, id]);
const invalid = () => new DocumentError("invalidInput", 400);

interface NativeCopySource {
  packageId: string;
  material: MemoryPackageMaterial;
  read(file: MemoryMaterialFile): Promise<Buffer>;
  verify(): Promise<void>;
}

function operationId(bucket: string, identity: string) {
  const hash = digest([copyKind, bucket, identity]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function fileForMarkdownImage(source: string, files: readonly MemoryMaterialFile[]) {
  if (/^(?:[a-z]+:|[\\/])/iu.test(source) || /[?#]/u.test(source)) return;
  const name = basename(decodeURIComponent(source));
  const matches = files.filter((file) => file.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

async function documentContent(source: NativeCopySource): Promise<PreparedDocumentCreation> {
  const { material, read } = source;
  const [original, ...images] = memoryMaterialOriginals(material);
  const text = new TextDecoder("utf-8", { fatal: true });
  const storedBody = material.files.find((file) => file.digest === material.document?.richBody);
  const bindings = new Map(material.document?.images.map((item) => [item.source, item.digest]));
  const embedded = new Map<string, MemoryMaterialFile>();
  let body;
  if (storedBody) {
    body = richDocumentInput(JSON.parse(text.decode(await read(storedBody)))).body;
    for (const id of richBodyImageIds(body)) {
      const digest = bindings.get(assetContentUrl(id));
      const file = images.find((item) => item.digest === digest);
      if (!file) throw invalid();
      embedded.set(id, file);
    }
  } else {
    if (!original || original.size > MAX_DOCUMENT_BYTES) throw new DocumentError("tooLarge", 413);
    body = richDocumentFromMarkdown(text.decode(await read(original)), (reference) => {
      const associated = bindings.get(reference);
      const file = associated
        ? images.find((item) => item.digest === associated)
        : fileForMarkdownImage(reference, images);
      if (!file) throw invalid();
      const id = operationId("document-image", file.digest);
      embedded.set(id, file);
      return assetContentUrl(id);
    });
  }
  if (embedded.size > 64 || [...embedded.values()].reduce((sum, file) => sum + file.size, 0) > 48 * 1024 * 1024)
    throw new DocumentError("assetTooLarge", 413);
  const prepared: PreparedDocumentCreation["images"] = await Promise.all(
    [...embedded].map(async ([id, file]) => ({ id, name: file.name, bytes: await read(file) })),
  );
  return { body, images: prepared };
}

export class MemoryNativeCopies {
  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly destination: (
      owner: string,
      project: string,
      kind: MemoryPackageMaterial["kind"],
    ) => Promise<{
      navigation: Pick<FileDocumentNavigation, "appendFromSource">;
      creations: Pick<FileCreativeAssets, "save">;
    }>,
  ) {}

  async include(owner: string, project: string, imports: MemoryArchiveImport[]) {
    if (!imports.some((item) => !item.withdrawn && item.materials?.length)) return imports;
    const bucket = namespace(owner, project);
    const rows = await this.metadata.list(copyKind, bucket);
    const byKey = new Map(rows.map((row) => [row.id, decode<{ copy: MemoryMaterialNativeCopy }>(row)!.copy]));
    return imports.map((item) => {
      if (item.withdrawn || !item.materials?.length) return item;
      const copies = Object.fromEntries(
        item.materials.flatMap((material) => {
          const copy = byKey.get(copyKey(bucket, sourceIdentity(material)));
          return copy ? [[material.id, copy] as const] : [];
        }),
      );
      return { ...item, copies };
    });
  }

  async copy(
    owner: string,
    project: string,
    source: NativeCopySource,
    signal: AbortSignal,
  ): Promise<MemoryMaterialNativeCopy> {
    const { material, packageId } = source;
    const bucket = namespace(owner, project);
    const identity = sourceIdentity(material);
    const key = copyKey(bucket, identity);
    const verify = async () => {
      if (signal.aborted) throw new HarnessError("unavailable", 503);
      await source.verify();
    };
    await verify();
    const previous = decode<{ copy: MemoryMaterialNativeCopy }>(await this.metadata.read(key));
    if (previous) {
      await verify();
      return previous.copy;
    }
    const target = await this.destination(owner, project, material.kind),
      operation = operationId(bucket, identity);
    const locale = material.locale ?? "en";
    let copy: MemoryMaterialNativeCopy;
    if (material.kind === "document") {
      const result = await target.navigation.appendFromSource(
        owner,
        { id: operation, projectId: project, parentId: null, title: material.title, locale },
        { identity: key, verify, prepare: () => documentContent(source) },
      );
      copy = { kind: "document", id: result.operation.documentId };
    } else {
      const [original, ...files] = material.files;
      const limits = CREATIVE_ASSET_LIMITS;
      if (
        !original ||
        original.size > limits.sourceBytes ||
        files.some((file) => file.size > limits.resourceBytes) ||
        material.files.reduce((sum, file) => sum + file.size, 0) > limits.totalBytes
      )
        throw new DocumentError("tooLarge", 413);
      const id = "c-" + operation;
      const input: CreativeSaveInput = {
        id,
        operationId: operation,
        expectedVersion: null,
        kind: material.kind,
        title: material.title,
        locale,
        name: original.name,
        bytes: await source.read(original),
        resources: await Promise.all(files.map(async (file) => ({ name: file.name, bytes: await source.read(file) }))),
      };
      const saveOriginal = () => target.creations.save(owner, project, input, signal, verify);
      try {
        await saveOriginal();
      } catch (error) {
        if (!(error instanceof DocumentError) || error.code !== "conflict") throw error;
        // A concurrent copy may have just committed this operation and can now be replayed.
        await verify();
        await saveOriginal();
      }
      copy = { kind: "asset", id };
    }
    await this.metadata.transaction(async (tx) => {
      if (!(await tx.get(key))) {
        await save(tx, key, copyKind, bucket, {
          copy,
          source: { packageId, id: material.id, version: material.version, checksum: identity },
        });
      }
    });
    return copy;
  }
}
