import { join } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationRecord, creationText, creationUuid, creationUuidFromDigest } from "../validation.js";
import {
  authoredDigest,
  authoredOptional,
  authoredVersion,
  type CreationFileVersion,
} from "./authored-file-version-records.js";
import { authoredFile } from "./authored-file-version-publish.js";
import type { CreationFileDirectory } from "./authored-files.js";
import type { CreationAuthoredFileVersions } from "./authored-file-versions.js";
import type { CreationFileLocations } from "./file-locations.js";
import type { CreationWorkspaceExport } from "./workspace-export-plan.js";

import { removeRelocatedFile } from "./file-relocation-removal.js";

interface Move {
  owner: string;
  id: string;
  source: CreationFileVersion;
  directory: string;
  identity: string;
  dev: string;
  ino: string;
}
function move(value: unknown): Move {
  const row = creationRecord(value, ["owner", "id", "source", "directory", "identity", "dev", "ino"]),
    source = authoredVersion(row.source),
    owner = creationText(row.owner, 200),
    dev = creationText(row.dev, 30),
    ino = creationText(row.ino, 30);
  if (source.owner !== owner || !/^\d+$/.test(dev) || !/^\d+$/.test(ino)) throw new CreationError("conflict");
  return {
    owner,
    id: creationUuid(row.id),
    source,
    directory: creationText(row.directory, 4096),
    identity: creationDigest(row.identity),
    dev,
    ino,
  };
}
/** The target must have an exclusive durable receipt before the unchanged owned source name can be removed. */
export class CreationFileRelocations {
  private readonly moves: FilePackageContent<Move>;
  private readonly completed: FilePackageContent<Move>;
  constructor(
    root: string,
    private readonly afterStep?: (step: "published" | "taken" | "removed" | "located") => Promise<void>,
  ) {
    const codec = {
      maxBytes: 16384,
      encode: async (v: Move) => Buffer.from(stableJson(move(v))),
      decode: async (bytes: Uint8Array) => move(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (v: Move) => authoredDigest(stableJson([v.owner, v.id])),
    };
    this.moves = new FilePackageContent(root + "/moves", codec);
    this.completed = new FilePackageContent(root + "/completed", codec);
  }
  async commit(options: {
    plan: CreationWorkspaceExport;
    version: CreationFileVersion;
    source: CreationFileDirectory;
    destination: CreationFileDirectory & { identity: string };
    versions: CreationAuthoredFileVersions;
    locations: CreationFileLocations;
    images(): Promise<void>;
  }) {
    const { plan, source, destination, versions, locations } = options,
      version = authoredVersion(options.version),
      id = creationUuidFromDigest(
        authoredDigest(stableJson(["creation-file-move", plan.owner, plan.taskId, plan.outputDigest])),
      ),
      key = authoredDigest(stableJson([plan.owner, id])),
      path = join(source.path, version.filename);
    if (source.path === destination.path) return version;
    let frozen = await authoredOptional(this.moves, key);
    await source.verify();
    await destination.verify();
    if (!frozen) {
      const original = await authoredFile(path);
      if (!original || original.digest !== version.digest || original.bytes !== version.bytes)
        throw new CreationError("conflict");
      frozen = {
        owner: plan.owner,
        id,
        source: version,
        directory: destination.path,
        identity: destination.identity,
        dev: String(original.dev),
        ino: String(original.ino),
      };
      await this.moves.put(frozen);
      if (stableJson(await this.moves.read(key)) !== stableJson(frozen)) throw new CreationError("conflict");
    }
    if (
      stableJson(frozen.source) !== stableJson(version) ||
      frozen.directory !== destination.path ||
      frozen.identity !== destination.identity
    )
      throw new CreationError("conflict");
    const located = await locations.after(plan.owner, plan.lineageId ?? plan.conversationId, version.id);
    if (
      located &&
      (located.id !== id ||
        located.directory !== destination.path ||
        located.directoryIdentity !== destination.identity)
    )
      throw new CreationError("conflict");
    if (located || (await authoredOptional(this.completed, key))) {
      const receipt = await versions.receipt(plan.owner, id);
      if (!receipt) throw new CreationError("conflict");
      await this.completed.put(frozen);
      return receipt;
    }
    const original = await authoredFile(path),
      prior = await versions.receipt(plan.owner, id);
    if (!original && !prior) throw new CreationError("conflict");
    if (
      original &&
      (String(original.dev) !== frozen.dev ||
        String(original.ino) !== frozen.ino ||
        original.digest !== version.digest ||
        original.bytes !== version.bytes)
    )
      throw new CreationError("conflict");
    await options.images();
    const relocated = await versions.write(plan.owner, id, destination, version.filename, plan.markdown);
    await versions.current(plan.owner, id, destination);
    await this.afterStep?.("published");
    await source.verify();
    await destination.verify();
    const current = await authoredFile(path);
    if (current) {
      if (
        String(current.dev) !== frozen.dev ||
        String(current.ino) !== frozen.ino ||
        current.digest !== version.digest ||
        current.bytes !== version.bytes
      )
        throw new CreationError("conflict");
    }
    await removeRelocatedFile(
      source,
      frozen,
      plan.lineageId ?? plan.conversationId,
      () => this.afterStep?.("taken") ?? Promise.resolve(),
    );
    await this.afterStep?.("removed");
    await locations.advance(plan.owner, plan.lineageId ?? plan.conversationId, version.id, {
      ...relocated,
      directoryIdentity: destination.identity,
    });
    await this.afterStep?.("located");
    await this.completed.put(frozen);
    return relocated;
  }
}
