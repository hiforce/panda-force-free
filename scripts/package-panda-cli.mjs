import { readFile, writeFile, mkdir, mkdtemp, chmod, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { CLI_VERSION } from "../src/shared/cli/version.js";
import { CLI_LOCAL_COMMANDS } from "../src/shared/cli/local-commands.js";
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
        localCommands: CLI_LOCAL_COMMANDS.map(([syntax, summary]) => ({ syntax, summary })),
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
const staging = await mkdtemp(resolve(tmpdir(), "panda-cli-npm-"));
const npm = resolve(directory, "hiforceai-panda-cli-" + CLI_VERSION + ".tgz");
try {
  await mkdir(resolve(staging, "bin"));
  for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(staging, name), bytes);
  await chmod(resolve(staging, "bin/panda.mjs"), 0o755);
  await writeFile(
    resolve(staging, "package.json"),
    JSON.stringify({
      name: "@hiforceai/panda-cli",
      version: CLI_VERSION,
      description: "PandaForce command-line client",
      license: "MIT",
      type: "module",
      engines: { node: ">=22" },
      bin: { panda: "./bin/panda.mjs" },
      files: ["bin/panda.mjs", "README.html", "commands.json", "LICENSE", "SHA256SUMS"],
    }),
  );
  const packed = Bun.spawn(["npm", "pack", staging, "--ignore-scripts", "--pack-destination", directory, "--json"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const receipt = await new Response(packed.stdout).json();
  if ((await packed.exited) !== 0 || resolve(directory, receipt[0]?.filename ?? "") !== npm)
    throw new Error("Panda CLI npm packaging failed");
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ version: CLI_VERSION, archive: path, npm, files: Object.keys(files), credentialsIncluded: false }),
);
