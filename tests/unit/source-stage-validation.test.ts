import { expect, test } from "bun:test";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import { sourceStageRequest } from "../../src/shared/packages/stages/input.js";
import { validateStagedSource } from "../../src/server/packages/staging/validation.js";

test("staged GitHub results bind repository identity, selected root, pinned ref and exact captured selection", async () => {
  const tree = await ImmutableSourceTree.create([{ path: "index.ejs", bytes: new TextEncoder().encode("Original") }]),
    origin = {
      kind: "github",
      repository: "https://github.com/example/themes",
      repositoryId: 42,
      root: "themes/company",
      requestedRef: "a".repeat(40),
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    inventory = {
      files: tree.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        integrity: { algorithm: "sha256" as const, value: file.sha256 },
      })),
      unavailable: [],
    },
    captured = await CapturedPackageSource.create(origin, inventory, tree),
    source = {
      kind: "github",
      repository: "example/themes",
      repositoryId: 42,
      root: "themes/company",
      ref: "a".repeat(40),
    };
  expect(() => validateStagedSource(sourceStageRequest({ source }), captured)).not.toThrow();
  for (const changed of [
    { repositoryId: 43 },
    { repository: "example/other" },
    { root: "other" },
    { ref: "c".repeat(40) },
  ])
    expect(() => validateStagedSource(sourceStageRequest({ source: { ...source, ...changed } }), captured)).toThrow(
      "sourceChanged",
    );
  expect(() => validateStagedSource(sourceStageRequest({ source, selected: [] }), captured)).toThrow("sourceChanged");
  const inconsistent = await CapturedPackageSource.create({ ...origin, commit: "c".repeat(40) }, inventory, tree);
  expect(() => validateStagedSource(sourceStageRequest({ source }), inconsistent)).toThrow("sourceChanged");
});
