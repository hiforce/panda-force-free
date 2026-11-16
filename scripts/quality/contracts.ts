import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditInterfaceStyles } from "./interface-styles.mjs";
import { spawnSync } from "node:child_process";

/** Contracts stay portable and explicit; runtime implementations satisfy them in composition. */
export function inspectContracts(directory?: string) {
  const failures: string[] = [];
  let interfaces = 0;
  const directories = directory
    ? [directory]
    : ["src/client/contracts", "src/server/contracts", "src/shared/engine"].map((path) => resolve(path));
  for (const folder of directories)
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".ts"))) {
      const source = ts.createSourceFile(
        name,
        readFileSync(resolve(folder, name), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(name + ": unconstrained any");
        if (ts.isInterfaceDeclaration(node)) interfaces++;
        if (ts.isTypeReferenceNode(node) && node.typeName.getText(source) === "ReturnType")
          if (
            node.typeArguments?.some(
              (argument) => ts.isTypeQueryNode(argument) && argument.exprName.getText(source) !== "setTimeout",
            )
          )
            failures.push(name + ": contract inferred from an implementation");
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  return { interfaces, failures };
}
if (import.meta.main) {
  const result = inspectContracts();
  const interfaceStyles = auditInterfaceStyles();
  const i18n = spawnSync(process.execPath, ["scripts/i18n/validate.mjs"], { encoding: "utf8" });
  if (i18n.status !== 0) result.failures.push("Internationalization: " + (i18n.stderr || i18n.stdout || i18n.error));
  result.failures.push(...interfaceStyles.failures);
  console.log(JSON.stringify({ ...result, interfaceStyles, i18n: i18n.stdout.trim() }));
  if (result.failures.length) process.exitCode = 1;
}
