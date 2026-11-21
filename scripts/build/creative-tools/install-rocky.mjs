import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = "/opt/panda-creative/inputs/";
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw Error(`${command} failed`);
};
const source = JSON.parse(readFileSync(root + "sources.lock.json")).rpmfusion;
run("curl", ["--fail", "--location", "--retry", "2", "--output", "/tmp/rpmfusion.rpm", source.url]);
if (createHash("sha256").update(readFileSync("/tmp/rpmfusion.rpm")).digest("hex") !== source.sha256)
  throw Error("Repository RPM checksum mismatch");
run("dnf", ["-y", "install", "/tmp/rpmfusion.rpm"]);
const manifest = JSON.parse(readFileSync(root + "manifest.json"));
const packages = [...new Set(Object.values(manifest.platforms.rocky9).flat())].sort();
if (packages.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/.test(name))) throw Error("Invalid reviewed RPM name");
run("dnf", ["-y", "install", ...packages]);
run("dnf", ["clean", "all"]);
