import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const packageName = "@agentclientprotocol/claude-agent-acp";
const source = fileURLToPath(new URL("./claude-tools/", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function readLock(directory) {
  const lock = await readJson(join(directory, "runtime.lock.json"));
  if (
    lock.schema !== 1 ||
    lock.platform !== "linux/amd64" ||
    !/^\d+\.\d+\.\d+$/.test(lock.claude.version) ||
    lock.claude.url !== `https://downloads.claude.ai/claude-code-releases/${lock.claude.version}/linux-x64/claude` ||
    !/^[\da-f]{64}$/.test(lock.claude.sha256) ||
    (await sha256(join(directory, "package-lock.json"))) !== lock.adapter.packageLockSha256
  )
    throw Error("Claude Code toolchain inputs do not match the reviewed lock");
  const npm = await readJson(join(directory, "package-lock.json"));
  if (npm.packages["node_modules/" + packageName]?.version !== lock.adapter.version)
    throw Error("Claude ACP adapter version does not match the reviewed lock");
  return lock;
}

async function verify(directory) {
  const lock = await readLock(directory);
  if ((await sha256(join(directory, "claude"))) !== lock.claude.sha256)
    throw Error("Native Claude Code binary checksum mismatch");
  const adapter = await readJson(join(directory, "node_modules", packageName, "package.json"));
  if (adapter.version !== lock.adapter.version) throw Error("Installed Claude ACP adapter version mismatch");
  console.log(JSON.stringify({ claude: lock.claude.version, adapter: lock.adapter.version }));
}

const [action, directory] = process.argv.slice(2);
if (!directory || !["prepare", "verify"].includes(action))
  throw Error("Usage: node scripts/build/claude-runtime.mjs prepare|verify <directory>");
if (action === "prepare") {
  const lock = await readLock(source);
  await mkdir(directory, { mode: 0o755 });
  for (const name of ["package.json", "package-lock.json", "runtime.lock.json"])
    await copyFile(join(source, name), join(directory, name));
  const response = await fetch(lock.claude.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw Error("Could not download the pinned Claude Code release");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(join(directory, "claude"), { mode: 0o755 }));
  if ((await sha256(join(directory, "claude"))) !== lock.claude.sha256)
    throw Error("Native Claude Code binary checksum mismatch");
  const npm = spawnSync(
    "npm",
    [
      "ci",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--registry",
      "https://registry.npmjs.org",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  if (npm.status !== 0) throw Error("Install of the pinned Claude ACP dependency tree failed");
}
await verify(directory);
