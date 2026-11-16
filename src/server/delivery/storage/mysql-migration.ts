import { dirname, join } from "node:path";
import { migrateSQLiteModule, type MigrationTable, type MigrationValue } from "../../database/data-migration.js";
import { deliveryMySQLModels } from "../../database/modules/delivery.js";
import { DELIVERY_SNAPSHOT_CONVERTER_VERSION, prepareDeliverySnapshot } from "./normalize-snapshot.js";
export const deliveryMigrationTables: readonly MigrationTable[] = deliveryMySQLModels.map((model) => {
  const columns = model.columns.map((c) => c.name),
    numericColumns = model.columns.filter((c) => /int/.test(c.type)).map((c) => c.name),
    keys = model.indexes.find((i) => i.name === "PRIMARY")!.columns;
  return {
    source: model.name.slice("panda_force_".length),
    target: model.name,
    columns,
    sourceKeys: keys,
    targetKeys: keys,
    numericColumns,
    project: (row) =>
      columns.map((column): MigrationValue => {
        const value = column === "rowSequence" ? row.__cursor : row[column];
        if (value === null || value === undefined) return null;
        if (!numericColumns.includes(column)) return value;
        const integer = Number(value);
        if (!Number.isSafeInteger(integer)) throw Error("migrationNumericOverflow");
        return integer;
      }),
  };
});
/** Frozen plans, snapshots, effects and recovery lineage preserve their original digests and uncertain outcomes. No remote action is attempted. */
export async function migrateDeliverySnapshot(
  options: Omit<Parameters<typeof migrateSQLiteModule>[0], "module" | "tables" | "converterVersion"> & {
    normalizedDirectory?: string;
  },
) {
  const frame = await prepareDeliverySnapshot({
    snapshotPath: options.snapshotPath,
    directory: options.normalizedDirectory ?? join(dirname(options.snapshotPath), "delivery-normalized"),
  });
  return migrateSQLiteModule({
    ...options,
    snapshotPath: frame.snapshotPath,
    module: "delivery",
    converterVersion: DELIVERY_SNAPSHOT_CONVERTER_VERSION,
    tables: deliveryMigrationTables,
  });
}
