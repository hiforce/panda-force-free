import type { Database } from "bun:sqlite";

/** Migration fixtures reconstruct the earlier inventory; production never drops budget guards. */
export function removeGenerationBudgetSchema(db: Database) {
  for (const { name } of db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_generation_%'",
    )
    .all()) {
    if (!/^[a-z_]+$/.test(name)) throw Error("Unexpected fixture trigger");
    db.exec('DROP TRIGGER "' + name + '"');
  }
  db.exec(
    "DROP TABLE knowledge_generation_pending; DROP TABLE knowledge_generation_totals; DROP TABLE knowledge_generation_limits;",
  );
  db.exec("DROP INDEX IF EXISTS knowledge_history_page;");
}

/** Remove only the additive type columns when constructing an actual schema7-or-earlier fixture. */
export function removeGenerationSourceSchema(db: Database) {
  for (const table of ["knowledge_generation_jobs", "knowledge_generation_origins"])
    db.exec(`ALTER TABLE ${table} DROP COLUMN sourceKind;`);
}
