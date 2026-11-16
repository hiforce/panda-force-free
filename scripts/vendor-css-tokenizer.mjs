import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const upstream = resolve(process.argv[2] || "node_modules/@csstools/css-tokenizer");
const target = "src/server/creative/assets/vendor";
const hashes = {
  "dist/index.mjs": "e0bbb8e192f342676c371806a3cec73a6ca593f6d4fd7bd942a84d2eb7d4e374",
  "dist/index.d.ts": "e330b2f5afe9c840ace7ff71fe48a15267cfc1d394df39f382b85dbffd2bfa68",
  "LICENSE.md": "d00d032f517721b45c56c70c46bf904ebb71ad313df4d4db7722266b38069665",
};
const metadata = JSON.parse(readFileSync(resolve(upstream, "package.json"), "utf8"));
if (metadata.name !== "@csstools/css-tokenizer" || metadata.version !== "3.0.4")
  throw new Error("Expected the reviewed CSS tokenizer version 3.0.4");
const files = Object.fromEntries(
  Object.entries(hashes).map(([path, expected]) => {
    const bytes = readFileSync(resolve(upstream, path));
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Upstream CSS tokenizer bytes changed: " + path);
    return [path, bytes];
  }),
);
if (!files["LICENSE.md"].equals(readFileSync("LICENSES/css-tokenizer-MIT.txt")))
  throw new Error("The complete upstream license must accompany the vendored module");
mkdirSync(target, { recursive: true });
const header =
  "// @ts-nocheck\n" +
  "// Generated from @csstools/css-tokenizer 3.0.4; upstream bytes follow unchanged.\n" +
  "// MIT license: LICENSES/css-tokenizer-MIT.txt. Regenerate with scripts/vendor-css-tokenizer.mjs.\n";
writeFileSync(target + "/css-tokenizer.js", Buffer.concat([Buffer.from(header), files["dist/index.mjs"]]));
writeFileSync(target + "/css-tokenizer.d.ts", files["dist/index.d.ts"]);
console.log("Vendored the pinned upstream CSS tokenizer without changing the NJ dependency profile.");
