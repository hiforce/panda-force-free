import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { MySQLCreationLedger } from "../../src/server/creation/storage/mysql.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlCreationModule } from "../../src/server/database/modules/creation.js";
import { creationAppFixture } from "../support/creation-app.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "MySQL creation metadata retains one portable file, owns conflict recovery and replays the same document after restart",
  async () => {
    const database = await isolatedMySQLDatabase("workfiles");
    let app: Awaited<ReturnType<typeof creationAppFixture>> | undefined;
    try {
      await new DatabaseRegistry().register(mysqlCreationModule).upgrade(new MySQLSchemaConnection(database.sql));
      const ledger = new MySQLCreationLedger(database.sql, "application");
      app = await creationAppFixture({
        storage: {
          tasks: ledger,
          queue: ledger.scheduling,
          questions: ledger.questions,
          progress: ledger.progress,
          goals: ledger.goals,
          messages: ledger.messages,
        },
      });
      const first = await app.create("Write the initial document"),
        original = await app.until(first.request.id, (task) => task.state === "succeeded"),
        path = original.artifact!.file!.path,
        initial = await readFile(path, "utf8");
      await writeFile(path, "Manual filesystem content");
      app.onRun(async (_input, callbacks, scope) => {
        await app!.save(callbacks, scope, "Updated requirements and acceptance criteria.");
      });
      const request = { taskId: original.id, id: randomUUID(), prompt: "Add acceptance criteria" };
      expect((await app.files.call("/api/document-creations/message", "POST", request)).status).toBe(202);
      const failed = await app.until(request.id, (task) => task.failure === "fileChanged");
      expect(failed.artifact).toBeNull();
      expect((await ledger.get("operator:test-user", request.id)).failure).toBe("fileChanged");
      expect(await readFile(path, "utf8")).toBe("Manual filesystem content");
      await app.restart();
      await writeFile(path, initial);
      const retry = { id: request.id, operationId: randomUUID() };
      expect((await app.files.call("/api/document-creations/retry", "POST", retry)).status).toBe(200);
      const saved = await app.until(request.id, (task) => task.state === "succeeded");
      expect(saved.artifact).toMatchObject({
        documentId: original.artifact!.documentId,
        revision: 2,
        file: { path, format: "markdown" },
      });
      expect(await readFile(path, "utf8")).toContain("Updated requirements and acceptance criteria");
      await app.restart();
      expect((await app.files.call("/api/document-creations/message", "POST", request)).body.task.artifact).toEqual(
        saved.artifact,
      );
      expect((await ledger.get("operator:test-user", saved.id)).artifact).toEqual(saved.artifact);
      expect((await app.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
      await expect(ledger.get("other", saved.id)).rejects.toThrow("notFound");
      await expect(
        new MySQLCreationLedger(database.sql, "another-application").get("operator:test-user", saved.id),
      ).rejects.toThrow("notFound");
    } finally {
      await app?.close();
      await database.close();
    }
  },
  60000,
);
