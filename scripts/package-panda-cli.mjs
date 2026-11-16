import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { CLI_VERSION } from "../src/shared/cli/version.js";
import { CLI_COMMANDS } from "../src/shared/cli/commands.js";
import { cliCommandSchema } from "../src/shared/cli/schema.js";
import { pandaCliManual } from "../src/shared/cli/manual.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const name = `panda-cli-${CLI_VERSION}`;
const result = await Bun.build({ entrypoints: [resolve(root, "src/cli/main.ts")], target: "node", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Panda CLI packaging failed");
const files = {
  "bin/panda.mjs": new Uint8Array(await result.outputs[0].arrayBuffer()),
  "README.html": new TextEncoder().encode(pandaCliManual()),
  "commands.json": new TextEncoder().encode(
    JSON.stringify(
      {
        schema: 1,
        protocol: 1,
        version: CLI_VERSION,
        commands: CLI_COMMANDS.map((spec) => ({ ...spec, inputSchema: cliCommandSchema(spec) })),
      },
      null,
      2,
    ) + "\n",
  ),
  LICENSE: new Uint8Array(await readFile(resolve(root, "LICENSE"))),
};
const checksums =
  Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => createHash("sha256").update(bytes).digest("hex") + "  " + path)
    .join("\n") + "\n";
files["SHA256SUMS"] = new TextEncoder().encode(checksums);
const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [name + "/" + path, bytes])), {
  level: 9,
  mtime: new Date("1980-01-02T00:00:00"),
});
const directory = resolve(root, "dist");
await mkdir(directory, { recursive: true });
const path = resolve(directory, name + ".zip");
await writeFile(path, archive);
await writeFile(path + ".sha256", createHash("sha256").update(archive).digest("hex") + "  " + name + ".zip\n");
console.log(
  JSON.stringify({ version: CLI_VERSION, archive: path, files: Object.keys(files), credentialsIncluded: false }),
);
