import type { Database } from "bun:sqlite";
import type { ReadQueries, ReadArguments } from "../../../shared/storage/read-queries.js";
import { ProjectContentError } from "../errors.js";

/** SQLite is also opened read-only. This facade prevents constructor writes and guards escaped statement lifetimes. */
export function migrationReadQueries(db: Database, assertOpen: () => void): ReadQueries {
  return Object.freeze({
    query<Row, Parameters extends (string | number | null)[]>(sql: string) {
      assertOpen();
      if (!/^\s*SELECT\b/i.test(sql)) throw new ProjectContentError("invalidFile");
      const statement = db.query<Row, Parameters>(sql);
      return Object.freeze({
        get(...values: ReadArguments<Parameters>) {
          assertOpen();
          return statement.get(...values);
        },
        all(...values: ReadArguments<Parameters>) {
          assertOpen();
          return statement.all(...values);
        },
        *iterate(...values: ReadArguments<Parameters>) {
          assertOpen();
          for (const row of statement.iterate(...values)) {
            assertOpen();
            yield row;
          }
        },
      });
    },
  });
}
