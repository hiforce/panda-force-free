import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureBase, dependencyProfile, verifyInputs } from "../../scripts/build/dependencies.mjs";

const roots: string[] = [];
function fixture(hook = false) {
  const root = mkdtempSync(join(tmpdir(), "panda-base-release-"));
  roots.push(root);
  mkdirSync(join(root, "patches"));
  mkdirSync(join(root, "scripts/build"), { recursive: true });
  const manifest = {
    name: "fixture",
    version: "0.0.21",
    dependencies: { example: "1.0.0" },
    scripts: hook ? { build: "compile", postinstall: "node install.js" } : { build: "compile" },
  };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "bun.lock"), "fixed lock\n");
  writeFileSync(join(root, "patches/example.patch"), "fixed patch\n");
  writeFileSync(join(root, "scripts/build/Dockerfile.bases"), "FROM example\n");
  const sums = join(root, "checksums"),
    snapshot = join(root, "inputs.json");
  writeFileSync(
    sums,
    ["package.json", "bun.lock", "patches/example.patch"]
      .map(
        (path) =>
          createHash("sha256")
            .update(readFileSync(join(root, path)))
            .digest("hex") +
          "  " +
          path,
      )
      .join("\n") + "\n",
  );
  captureBase(root, snapshot, sums);
  return { root, manifest, snapshot };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("release versions reuse dependency bases while dependency and lock changes remain blocking", () => {
  const { root, manifest, snapshot } = fixture(),
    before = dependencyProfile(root);
  manifest.version = "0.1.0";
  manifest.scripts.build = "compile updated application";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  expect(() => verifyInputs(root, snapshot)).not.toThrow();
  expect(dependencyProfile(root)).toBe(before);
  manifest.dependencies.example = "2.0.0";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  expect(() => verifyInputs(root, snapshot)).toThrow("Dependency inputs changed");
  manifest.dependencies.example = "1.0.0";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "bun.lock"), "changed lock\n");
  expect(() => verifyInputs(root, snapshot)).toThrow("Dependency inputs changed");
});
test("installation hooks retain the application version as an installation input", () => {
  const { root, manifest, snapshot } = fixture(true),
    before = dependencyProfile(root);
  manifest.version = "0.1.0";
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  expect(() => verifyInputs(root, snapshot)).toThrow("Dependency inputs changed");
  expect(dependencyProfile(root)).not.toBe(before);
});
