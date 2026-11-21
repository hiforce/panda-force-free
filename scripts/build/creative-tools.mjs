#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const installed = process.env.PANDA_FORCE_CREATIVE_HOME || "/opt/panda-creative";
const inputs = existsSync(join(here, "creative-tools/manifest.json"))
  ? join(here, "creative-tools")
  : join(installed, "inputs");
const read = (name) => JSON.parse(readFileSync(join(inputs, name), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(command, args, options = {}) {
  const child = spawnSync(command, args, { stdio: "inherit", ...options });
  if (child.status !== 0) throw Error(`${command} failed (${child.status ?? child.error?.code})`);
  return child;
}
export function validate(manifest = read("manifest.json"), pkg = read("package.json")) {
  if (manifest.schema !== 1 || !manifest.platforms?.rocky9) throw Error("Invalid creative toolchain manifest");
  for (const plugin of manifest.reviewedPlugins) {
    if (!plugin.id || !plugin.profiles.length) throw Error("Plugin must declare reviewed tool profiles");
    for (const profile of plugin.profiles)
      if (!manifest.profiles[profile]) throw Error(`Unknown tool profile ${profile} for ${plugin.id}`);
  }
  const expected = new Set(Object.values(manifest.profiles).flatMap((value) => value.node || []));
  if (Object.keys(pkg.dependencies).length !== expected.size || [...expected].some((name) => !pkg.dependencies[name]))
    throw Error("Creative Node dependencies differ from the reviewed profiles");
  for (const profile of Object.keys(manifest.profiles))
    if (!manifest.platforms.rocky9[profile]) throw Error(`Missing Rocky package mapping: ${profile}`);
  const declaredPython = [...new Set(Object.values(manifest.profiles).flatMap((value) => value.python || []))]
    .map((name) => name.toLowerCase())
    .sort();
  const actualPython = readFileSync(join(inputs, "requirements.in"), "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"))
    .sort();
  if (JSON.stringify(declaredPython) !== JSON.stringify(actualPython))
    throw Error("Creative Python requirements differ from the reviewed profiles");
  return manifest;
}
export function inputDigest(root = inputs) {
  const recipe = existsSync(join(root, "Dockerfile.rocky-bases"))
    ? join(root, "Dockerfile.rocky-bases")
    : join(here, "Dockerfile.rocky-bases");
  return hash(
    JSON.stringify({
      script: hash(
        readFileSync(
          existsSync(join(root, "creative-tools.mjs"))
            ? join(root, "creative-tools.mjs")
            : resolve(root, "../creative-tools.mjs"),
        ),
      ),
      recipe: hash(readFileSync(recipe)),
      files: Object.fromEntries(
        [
          "manifest.json",
          "package.json",
          "bun.lock",
          "requirements.in",
          "requirements.lock",
          "sources.lock.json",
          "install-rocky.mjs",
        ].map((name) => [name, hash(readFileSync(join(root, name)))]),
      ),
    }),
  );
}
function doctor() {
  const manifest = validate(),
    require = createRequire(join(installed, "node/package.json"));
  for (const name of new Set(Object.values(manifest.profiles).flatMap((value) => value.commands || [])))
    run("sh", ["-c", 'command -v "$1" >/dev/null', "doctor", name]);
  for (const name of Object.keys(read("package.json").dependencies)) require.resolve(name);
  run(join(installed, "python/bin/python"), [
    "-c",
    "import pptx, PIL, numpy, pandas, matplotlib, httpx, bs4, lxml, trafilatura, pymupdf, markitdown, docx, openpyxl, pypdf, reportlab, moviepy, pdf2image, defusedxml",
  ]);
  for (const families of Object.values(manifest.fonts))
    for (const family of families) {
      const result = spawnSync("fc-match", [family, "--format", "%{family}"], { encoding: "utf8" });
      if (result.status !== 0 || !result.stdout.includes(family)) throw Error(`Missing font: ${family}`);
    }
  console.log(
    JSON.stringify({
      schema: 1,
      status: "passed",
      inputsSha256: inputDigest(),
      profiles: Object.keys(manifest.profiles),
    }),
  );
}
async function build(args) {
  validate();
  const frozenDigest = inputDigest();
  const option = (name) => args[args.indexOf(name) + 1];
  for (const name of ["--work", "--build-tag", "--runtime-tag"])
    if (!args.includes(name) || !option(name) || option(name).startsWith("--")) throw Error(`Required ${name}`);
  const root = resolve(here, "../.."),
    work = resolve(option("--work")),
    context = join(work, "context");
  mkdirSync(context, { recursive: true });
  for (const name of [
    "package.json",
    "bun.lock",
    "patches",
    "scripts/build/creative-tools",
    "scripts/build/creative-tools.mjs",
    "scripts/build/Dockerfile.rocky-bases",
  ])
    cpSync(join(root, name), join(context, name), { recursive: true });
  const source = read("sources.lock.json").libreoffice,
    archive = join(work, "LibreOffice.tar.gz");
  if (!existsSync(archive) || hash(readFileSync(archive)) !== source.sha256) {
    // Preserve the compressed bytes even when a mirror sends Content-Encoding: gzip.
    run("curl", ["--fail", "--location", "--retry", "2", "--output", archive + ".partial", source.url]);
    if (hash(readFileSync(archive + ".partial")) !== source.sha256) throw Error("Office archive checksum mismatch");
    cpSync(archive + ".partial", archive);
  }
  if (hash(readFileSync(archive)) !== source.sha256) throw Error("Office archive checksum mismatch");
  cpSync(archive, join(context, "LibreOffice.tar.gz"));
  const common = ["build", "-f", join(context, "scripts/build/Dockerfile.rocky-bases")];
  for (const [optionName, arg] of [
    ["--seed-image", "SEED_IMAGE"],
    ["--rocky-image", "ROCKY_IMAGE"],
    ["--npm-registry", "NPM_REGISTRY"],
  ])
    if (args.includes(optionName)) common.push("--build-arg", `${arg}=${option(optionName)}`);
  const pullPolicy = args.includes("--pull")
    ? "always"
    : args.includes("--pull-policy")
      ? option("--pull-policy")
      : "if-not-present";
  if (!["always", "if-not-present", "never"].includes(pullPolicy)) throw Error("Invalid base pull policy");
  if (pullPolicy === "always") common.push("--pull");
  if (args.includes("--refresh-system")) common.push("--no-cache");
  if (pullPolicy === "never") {
    const recipe = readFileSync(join(root, "scripts/build/Dockerfile.rocky-bases"), "utf8");
    for (const [name, optionName] of [
      ["SEED_IMAGE", "--seed-image"],
      ["ROCKY_IMAGE", "--rocky-image"],
    ]) {
      const reference = args.includes(optionName)
        ? option(optionName)
        : recipe.match(new RegExp(`^ARG ${name}=(.+)$`, "m"))[1];
      run("docker", ["image", "inspect", "--format", "{{.Id}}", reference]);
    }
  }
  for (const [target, name] of [
    ["build-base", "--build-tag"],
    ["runtime-base", "--runtime-tag"],
  ])
    run("docker", [...common, "--target", target, "-t", option(name), context], {
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
  if (inputDigest() !== frozenDigest) throw Error("Creative inputs changed during the base build");
  const images = [];
  for (const name of ["--build-tag", "--runtime-tag"]) {
    const reference = option(name);
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", reference, "panda-tools", "inventory"], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw Error("Cannot verify the installed creative inventory");
    const inventory = JSON.parse(result.stdout);
    if (inventory.inputsSha256 !== frozenDigest) throw Error("Built base does not match the reviewed creative inputs");
    const image = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { encoding: "utf8" });
    if (image.status !== 0) throw Error("Cannot inspect the built base identity");
    images.push({ reference, imageId: image.stdout.trim(), inventory });
  }
  writeFileSync(
    join(work, "inputs.json"),
    JSON.stringify({ schema: 1, inputsSha256: frozenDigest, builtAt: new Date().toISOString(), images }, null, 2) +
      "\n",
  );
}
async function main() {
  const [command = "validate", ...args] = process.argv.slice(2);
  if (command === "validate" || command === "digest") {
    validate();
    console.log(inputDigest());
  } else if (command === "packages") {
    const manifest = validate(),
      platform = manifest.platforms[args[0]];
    if (!platform) throw Error("Unsupported creative toolchain platform");
    console.log([...new Set(Object.values(platform).flat())].sort().join("\n"));
  } else if (command === "verify-office") {
    if (hash(readFileSync(args[0])) !== read("sources.lock.json").libreoffice.sha256)
      throw Error("Office archive checksum mismatch");
  } else if (command === "download-source") {
    const source = read("sources.lock.json")[args[0]];
    if (!source || !args[1]) throw Error("Unknown reviewed source");
    run("curl", ["--fail", "--location", "--retry", "2", "--output", args[1], source.url]);
    if (hash(readFileSync(args[1])) !== source.sha256) throw Error("Source archive checksum mismatch");
  } else if (command === "doctor") doctor();
  else if (command === "inventory") {
    const result = spawnSync("rpm", ["-qa", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\\n"], { encoding: "utf8" });
    if (result.status !== 0) throw Error("Cannot read installed RPM inventory");
    console.log(
      JSON.stringify({
        schema: 1,
        inputsSha256: inputDigest(),
        operatingSystem: readFileSync("/etc/os-release", "utf8"),
        node: process.version,
        nodePackages: read("package.json").dependencies,
        office: read("sources.lock.json").libreoffice.version,
        rpms: result.stdout.trim().split("\n").sort(),
      }),
    );
  } else if (command === "fonts") console.log(JSON.stringify(read("manifest.json").fonts, null, 2));
  else if (command === "resolve") console.log(createRequire(join(installed, "node/package.json")).resolve(args[0]));
  else if (command === "build") await build(args);
  else
    throw Error(
      "Usage: creative-tools.mjs validate|packages rocky9|doctor|fonts|resolve <package>|build --work <directory> --build-tag <image> --runtime-tag <image> [--pull] [--seed-image <image>] [--rocky-image <image>] [--npm-registry <url>]",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
