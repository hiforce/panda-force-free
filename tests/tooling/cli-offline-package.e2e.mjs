import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import { CLI_VERSION } from "../../src/shared/cli/version.js";

const directory = await mkdtemp(join(tmpdir(), "panda-cli-package-"));
try {
  const build = spawnSync(process.execPath, ["scripts/package-panda-cli.mjs"], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const archive = await readFile(`dist/panda-cli-${CLI_VERSION}.zip`),
    prefix = `panda-cli-${CLI_VERSION}/`,
    entries = unzipSync(archive);
  assert.deepEqual(
    Object.keys(entries).sort(),
    ["LICENSE", "README.html", "SHA256SUMS", "bin/panda.mjs", "commands.json"].map((path) => prefix + path).sort(),
  );
  for (const line of new TextDecoder()
    .decode(entries[prefix + "SHA256SUMS"])
    .trim()
    .split("\n")) {
    const [digest, path] = line.split("  ");
    assert.equal(
      createHash("sha256")
        .update(entries[prefix + path])
        .digest("hex"),
      digest,
    );
  }
  const home = join(directory, "home"),
    entry = join(directory, "panda.mjs");
  await mkdir(home);
  await writeFile(entry, entries[prefix + "bin/panda.mjs"]);
  const env = { PATH: process.env.PATH, HOME: home, PANDA_CLI_HOME: join(directory, "profiles"), LANG: "en_US.UTF-8" };
  const image = process.env.PANDA_FORCE_CLI_NODE_IMAGE;
  const node = process.env.PANDA_FORCE_NODE22_BINARY || "node";
  const invoke = (args) =>
    image
      ? spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
            "--mount",
            `type=bind,source=${directory},target=/fixture`,
            "--env",
            "HOME=/fixture/home",
            "--env",
            "PANDA_CLI_HOME=/fixture/profiles",
            "--workdir",
            "/fixture",
            "--entrypoint",
            "node",
            image,
            ...args,
          ],
          { encoding: "utf8", timeout: 20000 },
        )
      : spawnSync(node, args, { encoding: "utf8", env, timeout: 5000 });
  const nodeVersion = invoke(["--version"]);
  assert.equal(nodeVersion.status, 0, nodeVersion.stderr);
  assert.ok(
    Number(nodeVersion.stdout.trim().replace(/^v/, "").split(".")[0]) >= 22,
    "Set PANDA_FORCE_NODE22_BINARY or an explicit local PANDA_FORCE_CLI_NODE_IMAGE when the host Node version is older than 22",
  );
  const run = (...args) => invoke([image ? "/fixture/panda.mjs" : entry, ...args]);
  const version = run("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).version, CLI_VERSION);
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /documents/);
  const guide = run("guide", "--json");
  assert.equal(guide.status, 0, guide.stderr);
  const reference = JSON.parse(guide.stdout);
  assert.ok(JSON.stringify(reference).includes("knowledge.edit"));
  const unauthorized = run("documents", "list", "--project", "personal", "--json");
  assert.equal(
    unauthorized.status,
    3,
    JSON.stringify({ error: unauthorized.error?.message, signal: unauthorized.signal, stderr: unauthorized.stderr }),
  );
  assert.equal(unauthorized.stdout, "");
  assert.match(unauthorized.stderr, /authenticationRequired/);
  console.log(
    "The closed offline archive runs on Node.js, preserves exact checksums, provides its guide and denies unregistered content access.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
