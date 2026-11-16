import type { Database } from "bun:sqlite";
import type { ReadQueries } from "../../src/shared/storage/read-queries.js";
import type { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { VariantRepository } from "../../src/server/publishing/variant-repository.js";

export function migrationReadContract(database: Database, source: LegacyProjectDocuments) {
  const nativeRead: ReadQueries = database;
  const row = nativeRead.query<{ id: string }, [string]>("SELECT id FROM documents WHERE id=?").get("document");
  const id: string | undefined = row?.id;
  void id;
  source.inspect((read) => {
    // @ts-expect-error Snapshot capabilities do not expose schema or row mutation.
    read.exec("DELETE FROM documents");
    // @ts-expect-error Read statements do not expose mutation methods.
    read.query("SELECT 1").run();
    // @ts-expect-error Application repositories cannot bootstrap schemas through the migration read capability.
    new VariantRepository(read);
    // @ts-expect-error Snapshot consumers cannot close the owning database.
    read.close();
  });
}
