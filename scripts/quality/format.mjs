import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const generated = new Set([
  "src/client/dom-elements.d.ts",
  "src/client/contracts/state-grants.d.ts",
  "src/shared/i18n/messages.d.ts",
  "src/shared/i18n/catalogs.js",
  "src/shared/i18n/server-catalogs.js",
]);
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + "/" + entry.name;
    return entry.isDirectory() ? walk(path) : /\.(?:js|ts|mjs|json)$/.test(path) && !generated.has(path) ? [path] : [];
  });
const files = [
  "package.json",
  "tsconfig.json",
  "tsconfig.strict.json",
  "tsconfig.contracts.json",
  "tsconfig.tooling.json",
  "eslint.config.mjs",
  "prettier.config.mjs",
  ...["src", "scripts", "tests"].flatMap(walk),
];
const child = Bun.spawn(
  [
    "bun",
    resolve("node_modules/prettier/bin/prettier.cjs"),
    process.argv.includes("--write") ? "--write" : "--check",
    ...files,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(await child.exited);
