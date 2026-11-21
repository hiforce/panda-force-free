#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, stat, chmod } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
const here = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!["--cache", "--output", "--lock"].includes(args[i]) || !args[i + 1] || flags.has(args[i]))
    throw Error("Invalid engine build arguments");
  flags.set(args[i], resolve(args[i + 1]));
}
const lockPath = flags.get("--lock") || join(here, "harness-engines.lock.json");
const cache = flags.get("--cache") || resolve(".artifacts/harness-engine-cache");
const output = flags.get("--output") || resolve(".artifacts/harness-engine-inputs");
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
async function download(url, maximum = 512 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw Error(`Engine download failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw Error("Engine download exceeds limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function validate(lock) {
  if (
    lock.schema !== 1 ||
    lock.platform !== "linux/amd64" ||
    !/^\d+\.\d+\.\d+$/.test(lock.codex?.version) ||
    !/^\d+\.\d+\.\d+$/.test(lock.grok?.version) ||
    !/^sha512-[A-Za-z0-9+/=]+$/.test(lock.codex.integrity) ||
    !/^[a-f0-9]{64}$/.test(lock.grok.sha256)
  )
    throw Error("Invalid stable engine lock");
  if (
    lock.grok.license?.url !== "https://raw.githubusercontent.com/xai-org/grok-build/main/LICENSE" ||
    !/^[a-f0-9]{64}$/.test(lock.grok.license.sha256)
  )
    throw Error("Invalid Grok license provenance");
  if (
    !lock.codex.url.startsWith("https://registry.npmjs.org/@openai/codex/-/") ||
    !lock.grok.url.startsWith(`https://x.ai/cli/grok-${lock.grok.version}-linux-x86_64`)
  )
    throw Error("Unexpected engine source");
}
async function grokBytes(version, url, fresh = false) {
  const target = join(cache, `grok-${version}-linux-x86_64`);
  if (!fresh) {
    try {
      if ((await stat(target)).isFile()) return await readFile(target);
    } catch {}
  }
  const bytes = gunzipSync(await download(url), { maxOutputLength: 512 * 1024 * 1024 });
  if (bytes[0] !== 0x7f || bytes.subarray(1, 4).toString() !== "ELF") throw Error("Invalid Linux Grok executable");
  await writeFile(target, bytes, { mode: 0o600 });
  return bytes;
}
if (command === "refresh") {
  await mkdir(cache, { recursive: true });
  const codex = JSON.parse(
    (await download("https://registry.npmjs.org/@openai%2Fcodex/latest", 4 * 1024 * 1024)).toString(),
  );
  const version = (await download("https://x.ai/cli/stable", 1024)).toString().trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Stable Grok version required");
  const licenseUrl = "https://raw.githubusercontent.com/xai-org/grok-build/main/LICENSE";
  const license = await download(licenseUrl, 65536);
  const url = `https://x.ai/cli/grok-${version}-linux-x86_64.gz`,
    bytes = await grokBytes(version, url, true);
  const lock = {
    schema: 1,
    platform: "linux/amd64",
    channel: "stable",
    checkedAt: new Date().toISOString(),
    codex: { version: codex.version, url: codex.dist.tarball, integrity: codex.dist.integrity },
    grok: { version, url, sha256: hash(bytes), license: { url: licenseUrl, sha256: hash(license) } },
  };
  validate(lock);
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(JSON.stringify({ codex: lock.codex.version, grok: lock.grok.version, platform: lock.platform }));
} else if (command === "prepare") {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  validate(lock);
  await mkdir(cache, { recursive: true });
  await mkdir(output, { recursive: true });
  const grok = await grokBytes(lock.grok.version, lock.grok.url),
    codex = await download(lock.codex.url, 32 * 1024 * 1024);
  if (hash(grok) !== lock.grok.sha256 || `sha512-${hash(codex, "sha512")}` !== lock.codex.integrity)
    throw Error("Engine checksum mismatch; original lock preserved");
  const license = await download(lock.grok.license.url, 65536);
  if (hash(license) !== lock.grok.license.sha256) throw Error("Grok license checksum mismatch");
  await writeFile(join(output, "grok-LICENSE"), license);
  await writeFile(join(output, "grok"), grok, { mode: 0o755 });
  await chmod(join(output, "grok"), 0o755);
  await writeFile(join(output, "codex.tgz"), codex);
  await copyFile(lockPath, join(output, "harness-engines.lock.json"));
  await copyFile(fileURLToPath(import.meta.url), join(output, "harness-engines.mjs"));
  console.log(JSON.stringify({ prepared: true, platform: lock.platform, output }));
} else if (command === "verify") {
  const lock = JSON.parse(await readFile(join(output, "harness-engines.lock.json"), "utf8"));
  validate(lock);
  if (
    hash(await readFile(join(output, "grok"))) !== lock.grok.sha256 ||
    `sha512-${hash(await readFile(join(output, "codex.tgz")), "sha512")}` !== lock.codex.integrity
  )
    throw Error("Engine build input checksum mismatch");
  if (hash(await readFile(join(output, "grok-LICENSE"))) !== lock.grok.license.sha256)
    throw Error("Engine license checksum mismatch");
  console.log("Pinned engine input checksums and license verified");
} else
  throw Error(
    "Usage: node scripts/build/harness-engines.mjs <refresh|prepare|verify> [--cache path] [--output path] [--lock path]",
  );
