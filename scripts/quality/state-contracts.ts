import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isRecord } from "../../src/shared/records.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = resolve(root, "src/client/contracts/state-grants.d.ts");
const manifest: unknown = JSON.parse(
  readFileSync(resolve(root, "src/client/application/state-contracts.json"), "utf8"),
);
if (!isRecord(manifest) || !isRecord(manifest.fields) || !isRecord(manifest.features))
  throw new Error("Invalid application state ownership manifest");
const names = Object.keys(manifest.fields).sort();
const lines: string[] = [];
const union = (items: readonly string[]) =>
  items.length ? items.map((item) => JSON.stringify(item)).join(" | ") : "never";
for (const [name, contract] of Object.entries(manifest.features).sort(([a], [b]) => a.localeCompare(b))) {
  if (!isRecord(contract) || !Array.isArray(contract.read) || !Array.isArray(contract.write))
    throw new Error("Invalid state grant: " + name);
  const reads: string[] = [],
    writes: string[] = [];
  for (const [values, target] of [
    [contract.read, reads],
    [contract.write, writes],
  ] as const)
    for (const value of values) {
      if (typeof value !== "string" || !names.includes(value) || target.includes(value))
        throw new Error("Unknown or duplicate state field: " + name);
      target.push(value);
    }
  if (writes.some((value) => !reads.includes(value)))
    throw new Error("State writers require a matching read grant: " + name);
  lines.push(`  ${name}: { read: ${union(reads)}; write: ${union(writes)} };`);
}
const output = `// Generated from reviewed state ownership metadata. Do not edit by hand.\nimport type { ApplicationState } from "./state.js";\n\nexport type OwnedStateField = ${union(names)};\nexport interface StateGrants {\n${lines.join("\n")}\n}\nexport type StateOwner = keyof StateGrants;\nexport type ReadFields<O extends StateOwner> = StateGrants[O]["read"];\nexport type WriteFields<O extends StateOwner> = StateGrants[O]["write"];\ntype AssertNever<T extends never> = T;\nexport type MissingOwnership = AssertNever<Exclude<keyof ApplicationState, OwnedStateField>>;\nexport type MissingState = AssertNever<Exclude<OwnedStateField, keyof ApplicationState>>;\n`;
if (process.argv.includes("--write")) writeFileSync(file, output);
else if (readFileSync(file, "utf8") !== output)
  throw new Error("State ownership types are stale; run check:state --write");
console.log("State ownership declarations verified: " + names.length + " fields");
