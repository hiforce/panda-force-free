import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessMetadata } from "../../src/server/harness/ports.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { LocalIndexEngine } from "../../src/server/search/providers/local-engine.js";
import { ProjectMemoryMaterialSearch } from "../../src/server/project-memory/material-search.js";
import {
  archiveImportKey,
  archiveImportKind,
  type MemoryArchiveReceipt,
} from "../../src/server/project-memory/portability.js";
import { digest, namespace } from "../../src/server/project-memory/records.js";
import { save } from "../../src/server/harness/records.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { textPdf } from "../support/material-text.js";
import { memoryImageTextFixture, recognizedImageText } from "../support/memory-image-text.js";

async function eventually<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("The materials index did not publish");
}

for (const backend of ["SQLite", "MySQL"]) {
  const run = backend === "SQLite" || process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE ? test : test.skip;
  run(
    backend + " fences material projections across workers, restart, project boundaries and withdrawal",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "panda-pmf-index-"));
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("pmfindex") : undefined;
      const owner = "reader";
      const project = "one";
      const bucket = namespace(owner, project);
      const packageId = crypto.randomUUID();
      const id = archiveImportKey(bucket, packageId);
      const input = {
        docs: Buffer.from("Finish the deck with hermetic primers.\n\npassword = hidden-marker\n"),
        pdf: Buffer.from(textPdf({ text: "Acoustic design requires cedar diffusion." })),
      };
      const receipt: MemoryArchiveReceipt = {
        packageId,
        added: 0,
        conflict: 0,
        duplicate: 0,
        invalid: 0,
        importedAt: Date.now(),
        withdrawn: false,
        checksum: "archive",
        materialDigest: "material-verify",
        materials: Object.entries(input).map(([id, bytes]) => ({
          id,
          title: id === "docs" ? "Finish specification" : "Acoustic guidance",
          kind: "file",
          version: "version7",
          files: [
            {
              name: id === "docs" ? "finishes.md" : "ceiling.pdf",
              size: bytes.length,
              digest: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        })),
      };
      const connect = (): HarnessMetadata =>
        mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(directory, "records.sqlite"));
      let first = connect();
      let second = connect();
      const store = {
        read: async (authorizedOwner: string, authorizedProject: string, checksum: string, digest: string) => {
          expect(authorizedOwner).toBe(owner);
          expect(authorizedProject).toBe(project);
          expect(checksum).toBe(receipt.materialDigest!);
          reads++;
          const [file] = receipt.materials!.find((material) => material.files[0]!.digest === digest)!.files;
          return file!.name === "ceiling.pdf" ? input.pdf : input.docs;
        },
      };
      let reads = 0;
      const create = (metadata: HarnessMetadata) =>
        new ProjectMemoryMaterialSearch(metadata, new LocalIndexEngine(directory), store, async () => {});
      let a = create(first);
      let b = create(second);
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        await first.transaction((tx) => save(tx, id, archiveImportKind, bucket, receipt));
        const reader = () => ({ get: (id: string) => first.read(id), list: first.list.bind(first) });
        const query = "cedar diffusion";
        // The package was already committed before this feature discovered it.
        expect((await a.find(owner, project, query, reader())).state).toBe("pending");
        const found = await eventually(async () => {
          a.wake();
          b.wake();
          const candidates = await a.lookup(owner, project, query);
          return candidates.hits.size ? candidates : undefined;
        });
        expect(reads).toBe(2);
        const hits = await a.results(owner, project, query, found, reader(), 10);
        expect(hits[0]?.location).toEqual({ kind: "page", number: 1 });
        expect(hits[0]?.excerpt).toContain("cedar diffusion");
        expect((await a.find(owner, project, "hidden-marker", reader())).hits).toEqual([]);
        expect(await a.results(owner, "other", query, found, reader(), 10)).toEqual([]);
        expect(await a.results("private-owner", project, query, found, reader(), 10)).toEqual([]);
        await Promise.all([a.close(), b.close()]);
        await Promise.all([first.close(), second.close()]);
        first = connect();
        second = connect();
        a = create(first);
        b = create(second);
        expect((await b.find(owner, project, query, reader())).hits[0]?.file.name).toBe("ceiling.pdf");
        expect(reads).toBe(2);
        await second.transaction(async (tx) => {
          await save(tx, id, archiveImportKind, bucket, { ...receipt, withdrawn: true });
          await b.withdraw(tx, owner, project, receipt);
        });
        expect(await b.results(owner, project, query, found, reader(), 10)).toEqual([]);
        expect((await b.find(owner, project, query, reader())).hits).toEqual([]);
      } finally {
        await Promise.all([a.close(), b.close()]);
        await Promise.all([first.close(), second.close()]);
        await mysql?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    35000,
  );
  const runOcr = process.env.PANDA_FORCE_TEST_MEMORY_OCR ? run : test.skip;
  runOcr(
    backend + " recognizes raster text in completed imports and revokes its regions with the source",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "panda-pmf-ocr-"));
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("pmfocr") : undefined;
      const metadata: HarnessMetadata = mysql
        ? new MySQLHarnessMetadata(mysql.sql)
        : new SQLiteHarnessMetadata(join(directory, "records.sqlite"));
      const owner = "architect",
        project = "building",
        bucket = namespace(owner, project);
      const packageId = crypto.randomUUID();
      const plans = await Promise.all(
        (
          [
            ["en", "en"],
            ["simplified", "zh-CN"],
            ["traditional", "zh-HK"],
          ] as const
        ).map(async ([variant, locale]) => {
          const bytes = await memoryImageTextFixture(variant);
          const file = {
            name: "section-" + variant + ".png",
            size: bytes.length,
            digest: createHash("sha256").update(bytes).digest("hex"),
          };
          const material = { id: variant, title: "Section Plan", kind: "image" as const, version: "saved-v2", locale };
          return { bytes, file, material };
        }),
      );
      const { file, material } = plans[0]!;
      const receipt: MemoryArchiveReceipt = {
        packageId,
        added: 0,
        conflict: 0,
        duplicate: 0,
        invalid: 0,
        importedAt: Date.now(),
        withdrawn: false,
        checksum: "archive",
        materialDigest: "image-only-upgrade",
        materials: [
          ...plans.map(({ material, file }) => ({ ...material, files: [file] })),
          {
            id: "notes",
            title: "Summary",
            kind: "file",
            version: "v1",
            files: [{ name: "summary.md", size: 62, digest: "a".repeat(64) }],
          },
        ],
      };
      const receiptId = archiveImportKey(bucket, packageId);
      const jobId = "memory-material-work:" + digest([bucket, packageId]);
      const fileId = digest([bucket, packageId, material.id, file.digest, file.name]);
      let reads = 0;
      const search = new ProjectMemoryMaterialSearch(
        metadata,
        new LocalIndexEngine(directory),
        {
          async read(selectedOwner, selectedProject, checksum, hash) {
            expect({ selectedOwner, selectedProject, checksum }).toEqual({
              selectedOwner: owner,
              selectedProject: project,
              checksum: receipt.materialDigest,
            });
            const plan = plans.find(({ file }) => file.digest === hash);
            if (!plan) throw new Error("OCR migration must leave non-image originals alone");
            reads++;
            return plan.bytes;
          },
        },
        async () => {},
      );
      const reader = { get: metadata.read.bind(metadata), list: metadata.list.bind(metadata) };
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        await metadata.transaction(async (tx) => {
          await save(tx, receiptId, archiveImportKind, bucket, receipt);
          // Preserve the exact shape of a completed pre-OCR import.
          await save(tx, jobId, "memory-material-complete", bucket, {
            owner,
            project,
            packageId,
            checksum: receipt.materialDigest,
            file: 4,
            attempts: 0,
          });
          await save(tx, "memory-material-projection:" + fileId, "memory-material-projection", bucket, {
            packageId,
            file,
            material,
            checksum: receipt.materialDigest,
            version: "before-image-text",
            sections: [],
            cues: [],
          });
        });
        expect((await search.find(owner, project, recognizedImageText.en, reader)).state).toBe("pending");
        const recognized = await eventually(async () => {
          search.wake();
          const result = await search.find(owner, project, recognizedImageText.en, reader);
          return result.state === "ready" && result.hits[0]?.recognition === "ocr" ? result.hits[0] : undefined;
        });
        expect(reads).toBe(3);
        expect(recognized.excerpt).toContain(recognizedImageText.en);
        expect(recognized.location?.kind).toBe("image");
        if (recognized.location?.kind !== "image") throw new Error("Image rectangle required");
        expect(recognized.location.y).toBeLessThan(0.25);
        for (const text of [recognizedImageText.simplified, recognizedImageText.traditional]) {
          const { hits } = await search.find(owner, project, text, reader);
          expect(hits[0]?.excerpt).toContain(text);
          expect(hits[0]?.recognition).toBe("ocr");
        }
        expect((await search.find(owner, project, recognizedImageText.excluded, reader)).hits).toEqual([]);
        await search.rebuild(owner, project);
        await eventually(async () => {
          search.wake();
          return reads === 6 && (await search.find(owner, project, recognizedImageText.en, reader)).state === "ready"
            ? true
            : undefined;
        });
        const stale = await search.lookup(owner, project, recognizedImageText.en);
        expect(await search.results(owner, "different-project", recognizedImageText.en, stale, reader, 10)).toEqual([]);
        expect(await search.results("different-owner", project, recognizedImageText.en, stale, reader, 10)).toEqual([]);
        await metadata.transaction(async (tx) => {
          await save(tx, receiptId, archiveImportKind, bucket, { ...receipt, withdrawn: true });
          await search.withdraw(tx, owner, project, receipt);
        });
        expect(await search.current(owner, project, fileId, reader)).toBeNull();
        expect(await search.results(owner, project, recognizedImageText.en, stale, reader, 10)).toEqual([]);
      } finally {
        await search.close();
        await metadata.close();
        await mysql?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    45000,
  );
}
