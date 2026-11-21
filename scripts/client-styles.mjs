import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const sources = JSON.parse(readFileSync(new URL("client-style-sources.json", import.meta.url), "utf8"));

/** Preserve the public URLs and cascade order while features own the source fragments. */
export function clientStyles(write = false) {
  const failures = [];
  for (const [output, inputs] of Object.entries(sources)) {
    const bytes = inputs.map((path) => readFileSync(new URL(path, root), "utf8")).join("");
    const target = new URL(output, root);
    if (write) writeFileSync(target, bytes);
    else if (readFileSync(target, "utf8") !== bytes)
      failures.push(`${output}: update the feature-owned CSS sources and run scripts/client-styles.mjs --write`);
  }
  return { outputs: Object.keys(sources), failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file://"))) {
  const result = clientStyles(process.argv.includes("--write"));
  console.log(JSON.stringify(result));
  if (result.failures.length) process.exitCode = 1;
}
