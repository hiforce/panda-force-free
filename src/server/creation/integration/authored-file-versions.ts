import { join } from "node:path";
import { opendir } from "node:fs/promises";
import { stableJson } from "../../../shared/stable-json.js";
import { CreationError } from "../contracts.js";
import { CreationAuthoredFiles, type CreationFileDirectory } from "./authored-files.js";
import { CreationAuthoredFileLeases } from "./authored-file-leases.js";
import {
  authoredDigest,
  authoredOptional,
  authoredText,
  authoredVersion,
  authoredVersionKey,
  authoredVersionStores,
  type CreationFileVersion,
} from "./authored-file-version-records.js";
import {
  authoredDirectory,
  authoredFile,
  authoredSync,
  assertAuthoredCurrent,
  cleanAuthoredVersion,
  publishAuthoredVersion,
} from "./authored-file-version-publish.js";

/** One stable document filename advances through owned, immutable receipts; unknown existing files are never adopted. */
export class CreationAuthoredFileVersions {
  private readonly stores: ReturnType<typeof authoredVersionStores>;
  private readonly files: CreationAuthoredFiles;
  private readonly leases: CreationAuthoredFileLeases;
  constructor(
    private readonly root: string,
    private readonly afterStep?: (step: "backed-up" | "published" | "receipted") => Promise<void>,
  ) {
    this.stores = authoredVersionStores(root);
    this.files = new CreationAuthoredFiles(join(root, "files"));
    this.leases = new CreationAuthoredFileLeases(join(root, "coordination"));
  }
  receipt(owner: string, id: string) {
    return authoredOptional(this.stores.receipts, authoredVersionKey(owner, id));
  }
  async current(owner: string, id: string, directory: CreationFileDirectory) {
    await authoredDirectory(directory);
    return this.leases.run(owner, async () => {
      const version = await this.receipt(owner, id);
      if (!version || version.directory !== directory.path) throw new CreationError("notFound");
      await assertAuthoredCurrent(version);
      await authoredDirectory(directory);
      return version;
    });
  }
  /** Bootstrap a pre-index conversation only from its existing owner/path-bound immutable receipts. */
  async discover(owner: string, base: CreationFileVersion, directory: CreationFileDirectory) {
    await authoredDirectory(directory);
    return this.leases.run(owner, async () => {
      const current = await authoredFile(join(directory.path, base.filename));
      if (!current || base.owner !== owner || base.directory !== directory.path) throw new CreationError("conflict");
      const receipts = await opendir(join(this.root, "receipts"));
      const matches: CreationFileVersion[] = [];
      let count = 0;
      for await (const entry of receipts) {
        if (++count > 8192) throw new CreationError("unavailable");
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const receipt = await this.stores.receipts.read(entry.name.slice(0, -5));
        if (
          receipt.owner === owner &&
          receipt.directory === directory.path &&
          receipt.filename === base.filename &&
          receipt.digest === current.digest &&
          receipt.bytes === current.bytes
        )
          matches.push(receipt);
      }
      const ancestors = new Set(matches.map((v) => v.previous));
      const found = matches.find((v) => !ancestors.has(v.id));
      if (!found) throw new CreationError("conflict");
      await authoredDirectory(directory);
      await assertAuthoredCurrent(found);
      return found;
    });
  }
  async write(
    owner: string,
    id: string,
    directory: CreationFileDirectory,
    filename: string,
    markdown: string,
    previous?: string,
  ) {
    const text = authoredText(markdown),
      version = authoredVersion({
        schema: 1,
        owner,
        id,
        directory: directory.path,
        filename,
        digest: authoredDigest(text),
        bytes: Buffer.byteLength(text),
        previous: previous ?? null,
      }),
      key = authoredVersionKey(owner, id);
    await authoredDirectory(directory);
    return this.leases.run(owner, async (lease) => {
      await authoredDirectory(directory);
      lease.assertHeld();
      await this.stores.inputs.put({ version, text });
      if (stableJson((await this.stores.inputs.read(key)).version) !== stableJson(version))
        throw new CreationError("conflict");
      const prior = await this.receipt(owner, id);
      const stem = ".panda-authored-" + key,
        prepared = join(directory.path, stem + ".md"),
        backup = join(directory.path, stem + ".previous.md");
      const base = previous ? await this.receipt(owner, previous) : null;
      if (previous && (!base || base.directory !== directory.path || base.filename !== filename))
        throw new CreationError("conflict");
      if (prior) {
        if (stableJson(prior) !== stableJson(version)) throw new CreationError("conflict");
        if (base) await this.cleanup(directory, version, base, key, prepared, backup, () => lease.assertHeld());
        return prior;
      }
      if (base) {
        let original = await authoredOptional(this.stores.moves, key);
        if (!original) {
          if (await authoredFile(backup)) throw new CreationError("conflict");
          await assertAuthoredCurrent(base);
        }
        await this.files.write(owner, id, directory, stem + ".md", text);
        if (!original) {
          await assertAuthoredCurrent(base);
          const current = await authoredFile(join(directory.path, filename)),
            staged = await authoredFile(prepared);
          if (!current || !staged) throw new CreationError("conflict");
          original = {
            owner,
            id,
            dev: String(current.dev),
            ino: String(current.ino),
            stagedDev: String(staged.dev),
            stagedIno: String(staged.ino),
          };
          await this.stores.moves.put(original);
          original = await this.stores.moves.read(key);
        }
        await publishAuthoredVersion({
          directory,
          version,
          previous: base,
          prepared,
          backup,
          original: { dev: BigInt(original.dev), ino: BigInt(original.ino) },
          stagedIdentity: { dev: BigInt(original.stagedDev), ino: BigInt(original.stagedIno) },
          assertHeld: () => lease.assertHeld(),
          afterStep: this.afterStep,
        });
      } else await this.files.write(owner, id, directory, filename, text);
      await authoredDirectory(directory);
      lease.assertHeld();
      await this.stores.receipts.put(version);
      if (stableJson(await this.stores.receipts.read(key)) !== stableJson(version)) throw new CreationError("conflict");
      await this.afterStep?.("receipted");
      if (base) await this.cleanup(directory, version, base, key, prepared, backup, () => lease.assertHeld());
      return version;
    });
  }
  private async cleanup(
    directory: CreationFileDirectory,
    version: CreationFileVersion,
    base: CreationFileVersion,
    key: string,
    prepared: string,
    backup: string,
    assertHeld: () => void,
  ) {
    if (await authoredOptional(this.stores.cleanups, key)) return;
    await authoredDirectory(directory);
    assertHeld();
    // A completed cleanup must never delete a later file created at a recycled temporary pathname.
    await this.stores.cleanups.put(version);
    if (stableJson(await this.stores.cleanups.read(key)) !== stableJson(version)) throw new CreationError("conflict");
    const original = await this.stores.moves.read(key);
    await cleanAuthoredVersion(backup, base, { dev: BigInt(original.dev), ino: BigInt(original.ino) });
    await cleanAuthoredVersion(prepared, version, { dev: BigInt(original.stagedDev), ino: BigInt(original.stagedIno) });
    await authoredSync(directory.path);
  }
}
