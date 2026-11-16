import type { Database } from "bun:sqlite";
import type { SchemaConnection, MigrationRecord, SchemaTable } from "./registry.js";

/** Use a dedicated maintenance connection before serving requests, never an application repository handle. */
export class SQLiteSchemaConnection implements SchemaConnection {
  readonly dialect = "sqlite" as const;
  private locked = false;
  constructor(readonly db: Database) {}
  async execute(sql: string) {
    this.db.exec(sql);
  }
  async table(name: string) {
    return !!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }
  async column(table: string, column: string) {
    return this.db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .some((c) => c.name === column);
  }
  async index(table: string, index: string) {
    return !!this.db
      .query("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?")
      .get(table, index);
  }
  async describe(table: string): Promise<SchemaTable | null> {
    if (!(await this.table(table))) return null;
    const columns = this.db
      .query<{ name: string; type: string; notnull: number }, [string]>(
        'SELECT name,type,"notnull" FROM pragma_table_info(?)',
      )
      .all(table);
    const indexes: SchemaTable["indexes"] = [];
    for (const index of this.db
      .query<{ name: string; unique: number }, [string]>('SELECT name,"unique" FROM pragma_index_list(?)')
      .all(table)) {
      indexes.push({
        name: index.name,
        unique: !!index.unique,
        columns: this.db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(index.name)
          .map((c) => c.name),
      });
    }
    return {
      name: table,
      columns: columns.map((c) => ({ name: c.name, type: c.type.toLowerCase(), nullable: !c.notnull })),
      indexes,
    };
  }
  async history(module: string, version: number): Promise<MigrationRecord | null> {
    return this.db
      .query<MigrationRecord, [string, number, number]>(
        "SELECT version,checksum,step,state FROM panda_force_schema_migrations WHERE module=? AND (?=0 OR version=?) ORDER BY version DESC LIMIT 1",
      )
      .get(module, version, version);
  }
  async record(module: string, value: MigrationRecord) {
    this.db
      .query(
        "INSERT INTO panda_force_schema_migrations VALUES(?,?,?,?,?,?) ON CONFLICT(module,version) DO UPDATE SET checksum=excluded.checksum,step=excluded.step,state=excluded.state,updatedAt=excluded.updatedAt",
      )
      .run(module, value.version, value.checksum, value.step, value.state, Date.now());
  }
  async exclusive<T>(work: () => Promise<T>) {
    if (this.locked) throw new Error("schemaMigrationBusy");
    this.locked = true;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS panda_force_schema_migrations(module TEXT NOT NULL,version INTEGER NOT NULL,checksum TEXT NOT NULL,step INTEGER NOT NULL,state TEXT NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(module,version))",
      );
      const result = await work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.locked = false;
    }
  }
}
