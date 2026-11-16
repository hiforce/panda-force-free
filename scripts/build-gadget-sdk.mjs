import { mkdir, writeFile, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve("dist/gadget-sdk");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
for (const entry of ["client", "server", "frame"]) {
  const result = await Bun.build({
    entrypoints: [`src/gadget/sdk/${entry}.ts`],
    outdir: root,
    naming: entry + ".js",
    target: entry === "frame" ? "browser" : "node",
    format: "esm",
    minify: false,
  });
  if (!result.success) throw new AggregateError(result.logs, "SDK build failed");
}
const config = {
  compilerOptions: {
    strict: true,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: root + "/types",
    rootDir: resolve("."),
    target: "ES2023",
    module: "ESNext",
    moduleResolution: "Bundler",
    skipLibCheck: true,
    types: ["node"],
    lib: ["ES2023", "DOM"],
  },
  files: ["client", "server", "frame"].map((name) => resolve(`src/gadget/sdk/${name}.ts`)),
};
const configPath = resolve(".artifacts/gadget-workbench/sdk-tsconfig.json");
await mkdir(resolve(".artifacts/gadget-workbench"), { recursive: true });
await writeFile(configPath, JSON.stringify(config));
const typecheck = Bun.spawn(["bun", "node_modules/typescript/bin/tsc", "-p", configPath], {
  stdout: "inherit",
  stderr: "inherit",
});
if (await typecheck.exited) throw Error("SDK declarations failed");
await writeFile(
  root + "/package.json",
  JSON.stringify(
    {
      name: "@hiforceai/panda-gadget-sdk",
      version: "0.1.0",
      private: true,
      type: "module",
      license: "MIT",
      exports: Object.fromEntries(
        ["client", "server", "frame"].map((name) => [
          "./" + name,
          { types: `./types/src/gadget/sdk/${name}.d.ts`, import: `./${name}.js` },
        ]),
      ),
    },
    null,
    2,
  ),
);
await cp("src/gadget/sdk/README.html", root + "/README.html");
await cp("LICENSE", root + "/LICENSE");
const packed = Bun.spawn(
  ["tar", "-czf", resolve("dist/panda-gadget-sdk-0.1.0.tgz"), "-C", root, "--transform=s,^,package/,", "."],
  { stdout: "inherit", stderr: "inherit" },
);
if (await packed.exited) throw Error("SDK archive failed");
console.log(JSON.stringify({ directory: root, archive: resolve("dist/panda-gadget-sdk-0.1.0.tgz") }));
