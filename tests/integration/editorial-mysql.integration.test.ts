import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlEditorialModule } from "../../src/server/database/modules/editorial.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { EditorialRepository } from "../../src/server/editorial/repository.js";
import { EditorialJobRepository } from "../../src/server/editorial/jobs/repository.js";
import { MySQLEditorialRepository } from "../../src/server/editorial/mysql-repository.js";
import { MySQLEditorialSession } from "../../src/server/editorial/mysql-session.js";
import { MySQLEditorialJobRepository } from "../../src/server/editorial/jobs/mysql-repository.js";
import { importEditorialSQLite } from "../../src/server/editorial/mysql-import.js";
import { createMySQLEditorialFeature } from "../../src/server/editorial/integration/mysql-feature.js";
import type { AsyncEditorialSources, AppliedEditorialSource } from "../../src/server/editorial/async-ports.js";
import type { EditorialProposal } from "../../src/shared/editorial/contracts.js";
const enabled = !!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE,
  ref = {
    projectId: "project-1",
    documentId: "document-1",
    revisionId: "revision-1",
    version: 1,
    sourceHash: "a".repeat(64),
  };
const proposal = (id = randomUUID()): EditorialProposal => ({
  schema: 1,
  id,
  source: ref,
  mode: "spacing",
  producer: { kind: "rules", version: "1" },
  edits: [],
  truncated: false,
  createdAt: 10000,
});
const jobSpec = (id = randomUUID()) => ({
  schema: 1 as const,
  id,
  proposalId: randomUUID(),
  source: { ref },
  mode: "proofread" as const,
  profile: { id: "review", kind: "responses" as const, engine: "responses", model: "fixture", version: "1" },
});
test.skipIf(!enabled)(
  "editorial MySQL import preserves proposal/history order and leases; native job transactions fence cancellation and roll back proposals",
  async () => {
    const f = await isolatedMySQLDatabase("editorial"),
      root = await mkdtemp(join(tmpdir(), "editorial-mysql-")),
      db = new Database(join(root, "source.sqlite"));
    try {
      const legacy = new EditorialRepository(db),
        jobs = new EditorialJobRepository(db),
        a = proposal(),
        b = proposal(),
        spec = jobSpec();
      legacy.create("owner", "request-a", a);
      legacy.create("owner", "request-b", b);
      jobs.create("owner", "request-job", spec, 10000);
      const snapshotPath = join(root, "snapshot.sqlite");
      db.query("VACUUM INTO ?").run(snapshotPath);
      const schema = new MySQLSchemaConnection(f.sql);
      await new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlEditorialModule).upgrade(schema);
      await importEditorialSQLite({ sql: f.sql, snapshotPath, migrationId: "editorial-v1" });
      await importEditorialSQLite({ sql: f.sql, snapshotPath, migrationId: "editorial-v1" });
      expect(await mysqlEditorialModule.inspect(schema)).toEqual([]);
      const session = new MySQLEditorialSession(f.sql),
        repo = new MySQLEditorialRepository(session),
        first = new MySQLEditorialJobRepository(session),
        second = new MySQLEditorialJobRepository(new MySQLEditorialSession(f.sql));
      expect(await repo.get("owner", a.id)).toEqual(legacy.get("owner", a.id));
      expect(await repo.list("owner", ref.documentId, ref.projectId)).toEqual([b.id, a.id]);
      expect(await repo.historyPage("owner", ref.documentId, null, ref.projectId)).toEqual(
        legacy.historyPage("owner", ref.documentId, null, ref.projectId),
      );
      await expect(repo.get("other", a.id)).rejects.toMatchObject({ status: 404 });
      const claims = await Promise.all([first.claim(10001, 30000), second.claim(10001, 30000)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claim = claims.find(Boolean)!;
      await second.cancel("owner", spec.id, 10002);
      let callbacks = 0;
      await expect(
        first.complete(claim, 10003, () => {
          callbacks++;
          return a.id;
        }),
      ).rejects.toThrow("leaseLost");
      expect(callbacks).toBe(0);
      const retryId = randomUUID();
      await first.retry("owner", spec.id, retryId, 10004);
      await second.retry("owner", spec.id, retryId, 10005);
      const retried = await first.claim(10006, 30000);
      expect(retried!.job.generation).toBe(1);
      const rollback = proposal(spec.proposalId);
      await expect(
        first.complete(retried!, 10007, async () => {
          await repo.create("owner", "prepared", rollback);
          throw Error("injected rollback");
        }),
      ).rejects.toThrow("injected rollback");
      await expect(repo.get("owner", rollback.id)).rejects.toMatchObject({ status: 404 });
      expect((await first.get("owner", spec.id)).job.state).toBe("running");
      await first.complete(retried!, 10008, async () => {
        await repo.create("owner", "prepared", rollback);
        return rollback.id;
      });
      expect((await first.get("owner", spec.id)).job.state).toBe("succeeded");
      expect((await repo.get("owner", rollback.id)).proposal).toEqual(rollback);
    } finally {
      db.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
test.skipIf(!enabled)(
  "async editorial service durably reserves selection before native writes and recovers a torn metadata receipt without rewriting a later source",
  async () => {
    const f = await isolatedMySQLDatabase("editorial");
    try {
      await new DatabaseRegistry().register(mysqlEditorialModule).upgrade(new MySQLSchemaConnection(f.sql));
      let writes = 0,
        current = { ...ref },
        applied: AppliedEditorialSource | null = null,
        allowed = true;
      const body = {
        schema: 1 as const,
        format: "richtext" as const,
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Two  spaces." }] }] },
      };
      const sources: AsyncEditorialSources = {
        authorize: async () => {
          if (!allowed) throw Error("access revoked");
          return () => {
            if (!allowed) throw Error("access revoked");
          };
        },
        current: async () => current,
        revision: async () => ({ ref, body }),
        applied: async () => applied,
        apply: async (intent, _body, completion) => {
          const previous = await completion.receipt();
          if (previous) return previous;
          if (!applied) {
            writes++;
            applied = {
              ref: { ...ref, revisionId: "applied-revision", version: 2, sourceHash: "b".repeat(64) },
              commit: "c".repeat(40),
            };
            current = applied.ref;
          }
          return completion.record(applied);
        },
      };
      const feature = createMySQLEditorialFeature(f.sql, sources),
        prepared = await feature.service.prepare("owner", {
          id: randomUUID(),
          documentId: ref.documentId,
          revisionId: ref.revisionId,
          projectId: ref.projectId,
          mode: "spacing",
        }),
        selection = [prepared.proposal.edits[0]!.id],
        input = { id: prepared.proposal.id, digest: prepared.digest, selected: selection };
      expect(prepared.proposal.edits.length).toBe(1);
      await f.sql.unsafe(
        "CREATE TRIGGER reject_editorial_receipt BEFORE INSERT ON panda_force_editorial_applications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected receipt failure'",
      );
      await expect(feature.service.accept("owner", input)).rejects.toThrow();
      expect(writes).toBe(1);
      expect(await feature.repository.intent("owner", prepared.proposal.id)).not.toBeNull();
      await f.sql.unsafe("DROP TRIGGER reject_editorial_receipt");
      current = { ...ref, version: 3, revisionId: "later-revision", sourceHash: "d".repeat(64) };
      const recovered = await createMySQLEditorialFeature(f.sql, sources).service.detail("owner", prepared.proposal.id);
      expect(recovered.receipt!.applied.revisionId).toBe("applied-revision");
      expect(current.revisionId).toBe("later-revision");
      expect(writes).toBe(1);
      expect(await feature.service.accept("owner", input)).toEqual(recovered.receipt);
      allowed = false;
      await expect(feature.service.detail("owner", prepared.proposal.id)).rejects.toThrow("access revoked");
    } finally {
      await f.close();
    }
  },
  90000,
);

test.skipIf(!enabled)(
  "MySQL editorial receipts and relational document revisions share one rollback boundary",
  async () => {
    const { mysqlDocumentsModule } = await import("../../src/server/database/modules/documents.js"),
      { createMySQLDocumentFeature } = await import("../../src/server/documents/mysql-feature.js"),
      { mysqlDocumentEditorialSources } =
        await import("../../src/server/editorial/integration/mysql-document-source.js");
    const f = await isolatedMySQLDatabase("editorial"),
      root = await mkdtemp(join(tmpdir(), "editorial-doc-mysql-"));
    try {
      await new DatabaseRegistry()
        .register(mysqlDocumentsModule)
        .register(mysqlEditorialModule)
        .upgrade(new MySQLSchemaConnection(f.sql));
      const documents = createMySQLDocumentFeature({
          sql: f.sql,
          stateRoot: root,
          allowedRoots: [],
          requireProject(id) {
            if (id !== "project-1") throw Error("notFound");
          },
        }),
        space = await documents.service.createSpace({
          projectId: "project-1",
          code: "source",
          name: "Source",
          engine: "markdown",
          theme: "default",
          sourceMode: "managed",
          locale: "en",
        }),
        original = await documents.service.createDocument({
          spaceId: space.id,
          path: "source.md",
          title: "Source",
          locale: "en",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Two  spaces." }] }],
            },
          },
        }),
        editorial = createMySQLEditorialFeature(f.sql, (session) =>
          mysqlDocumentEditorialSources(documents.service, documents.storage.session, session),
        );
      const prepared = await editorial.service.prepare("owner", {
          id: randomUUID(),
          documentId: original.document.id,
          revisionId: original.revision.id,
          mode: "spacing",
        }),
        input = { id: prepared.proposal.id, digest: prepared.digest, selected: [prepared.proposal.edits[0]!.id] };
      await f.sql.unsafe(
        "CREATE TRIGGER reject_editorial_receipt BEFORE INSERT ON panda_force_editorial_applications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected receipt failure'",
      );
      await expect(editorial.service.accept("owner", input)).rejects.toThrow();
      expect((await documents.service.detail(original.document.id)).document.revision).toBe(1);
      expect(await documents.service.documents.revisions(original.document.id)).toHaveLength(1);
      expect(await editorial.repository.intent("owner", prepared.proposal.id)).not.toBeNull();
      await f.sql.unsafe("DROP TRIGGER reject_editorial_receipt");
      const accepted = await Promise.all([
        editorial.service.accept("owner", input),
        editorial.service.accept("owner", input),
      ]);
      expect(accepted[0]).toEqual(accepted[1]);
      expect((await documents.service.detail(original.document.id)).document.revision).toBe(2);
      expect((await documents.service.detail(original.document.id)).revision.content).toContain("Two spaces.");
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
