import type { SchemaConnection, SchemaIssue, SchemaTable } from "./registry.js";

/** Additional columns and indexes are preserved; required definitions must match exactly. */
export async function inspectTable(
  connection: SchemaConnection,
  module: string,
  expected: SchemaTable,
): Promise<SchemaIssue[]> {
  const actual = await connection.describe(expected.name);
  if (!actual) return [{ module, object: expected.name, code: "missingTable" }];
  const issues: SchemaIssue[] = [];
  for (const column of expected.columns) {
    const current = actual.columns.find((c) => c.name === column.name);
    if (!current) issues.push({ module, object: expected.name + "." + column.name, code: "missingColumn" });
    else if (
      current.type !== column.type ||
      current.nullable !== column.nullable ||
      (column.collation !== undefined && current.collation !== column.collation) ||
      (column.autoIncrement !== undefined && current.autoIncrement !== column.autoIncrement) ||
      (column.defaultValue !== undefined &&
        (column.defaultValue === null
          ? current.defaultValue !== null
          : current.defaultValue === null || String(current.defaultValue) !== String(column.defaultValue)))
    )
      issues.push({ module, object: expected.name + "." + column.name, code: "incompatibleColumn" });
  }
  for (const index of expected.indexes) {
    const current = actual.indexes.find((i) => i.name === index.name);
    if (!current) issues.push({ module, object: expected.name + "." + index.name, code: "missingIndex" });
    else if (current.unique !== index.unique || JSON.stringify(current.columns) !== JSON.stringify(index.columns))
      issues.push({ module, object: expected.name + "." + index.name, code: "incompatibleIndex" });
  }
  return issues;
}
