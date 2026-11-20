#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const descriptiveFields = [
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "contributors",
  "funding",
  "repository",
];
const installScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function patchFiles(root) {
  const paths = [];
  function walk(directory) {
    for (const name of readdirSync(resolve(root, directory)).sort()) {
      const path = directory + "/" + name;
      const info = lstatSync(resolve(root, path));
      if (info.isSymbolicLink()) throw new Error("Dependency input must not be a symbolic link: " + path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) paths.push(path);
      else throw new Error("Dependency input must be a regular file: " + path);
    }
  }
  walk("patches");
  return paths.sort();
}

export function dependencyInputs(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const key of descriptiveFields) delete manifest[key];
  // Hooks may invoke other scripts, so retain the entire script map when hooks exist.
  if (!installScripts.some((key) => Object.hasOwn(manifest.scripts || {}, key))) {
    manifest.scripts = {};
    // A release number cannot change installed dependencies without a root installation hook.
    delete manifest.version;
  }
  const files = Object.fromEntries(
    ["bun.lock", ...patchFiles(root)].map((path) => [path, hash(readFileSync(resolve(root, path)))]),
  );
  return canonical({ schema: 1, manifest, files });
}

export function dependencyProfile(root) {
  return hash(
    JSON.stringify({
      inputs: dependencyInputs(root),
      recipe: hash(readFileSync(resolve(root, "scripts/build/Dockerfile.bases"))),
    }),
  );
}

export function captureBase(root, target, legacyManifest) {
  const inputs = dependencyInputs(root);
  const expected = new Map(
    readFileSync(legacyManifest, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
        if (!match) throw new Error("Invalid base dependency checksum manifest");
        return [match[2], match[1]];
      }),
  );
  const paths = ["package.json", ...Object.keys(inputs.files)];
  if (
    expected.size !== paths.length ||
    paths.some((path) => expected.get(path) !== hash(readFileSync(resolve(root, path))))
  ) {
    throw new Error("Base dependency inputs do not match their recorded checksums");
  }
  writeFileSync(target, JSON.stringify(inputs) + "\n", { mode: 0o600 });
}

export function verifyInputs(root, target) {
  const expected = JSON.parse(readFileSync(target, "utf8"));
  if (JSON.stringify(dependencyInputs(root)) !== JSON.stringify(canonical(expected))) {
    throw new Error(
      "Dependency inputs changed: installation metadata, lockfile or patches differ from the selected base. Rebuild and import both bases explicitly.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root = ".", target, legacyManifest] = process.argv.slice(2);
  if (command === "capture" && target && legacyManifest) captureBase(root, target, legacyManifest);
  else if (command === "verify" && target) verifyInputs(root, target);
  else if (command === "profile") console.log(dependencyProfile(root));
  else
    throw new Error(
      "Usage: dependencies.mjs capture <root> <snapshot> <base-checksums> | verify <root> <snapshot> | profile <root>",
    );
}
