#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "creative-tools");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const run = (command, values) => {
  const child = spawnSync(command, values, { cwd: directory, stdio: "inherit" });
  if (child.status !== 0) throw Error(`${command} failed`);
};
const pkg = JSON.parse(readFileSync(resolve(directory, "package.json")));
for (const name of Object.keys(pkg.dependencies)) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
  if (!response.ok) throw Error(`Cannot resolve ${name}`);
  pkg.dependencies[name] = (await response.json()).version;
}
writeFileSync(resolve(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
run(option("--bun") || "bun", ["install", "--lockfile-only", "--ignore-scripts"]);
const uv = option("--uv") || "uv";
const version = spawnSync(uv, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || !version.stdout.startsWith("uv 0.13.9")) throw Error("Use the reviewed uv 0.13.9 resolver");
run(uv, [
  "pip",
  "compile",
  "requirements.in",
  "--python-version",
  "3.11",
  "--python-platform",
  "x86_64-unknown-linux-gnu",
  "--generate-hashes",
  "--upgrade",
  "--no-emit-index-url",
  "--output-file",
  "requirements.lock",
]);
{
  let version = option("--office-version");
  if (!version) {
    const response = await fetch("https://download.documentfoundation.org/libreoffice/stable/");
    if (!response.ok) throw Error("Cannot read official stable Office releases");
    const versions = [...(await response.text()).matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((match) => match[1]);
    version = [...new Set(versions)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (!version) throw Error("No official stable Office release found");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Invalid Office release version");
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/rpm/x86_64/LibreOffice_${version}_Linux_x86-64_rpm.tar.gz`;
  const response = await fetch(url + ".sha256");
  if (!response.ok) throw Error("Cannot read the official Office checksum");
  const sha256 = (await response.text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error("Invalid official Office checksum");
  const file = resolve(directory, "sources.lock.json"),
    sources = JSON.parse(readFileSync(file));
  sources.libreoffice = { version, url, sha256 };
  writeFileSync(file, JSON.stringify(sources, null, 2) + "\n");
}
console.log(
  "Creative dependency locks refreshed. Rebuild both bases and run the offline smoke before selecting new digests. Refresh Harness locks separately with harness-engines.mjs.",
);
