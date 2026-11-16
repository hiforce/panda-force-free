import { expect, test } from "bun:test";
import { sourceStageRequest, stageId, stagePurpose } from "../../src/shared/packages/stages/input.js";

test("source stage intents normalize repository addresses and retain selection semantics without accepting raw credentials", () => {
  const value = sourceStageRequest({
    source: {
      kind: "github",
      repository: "example/templates",
      ref: "release/stable",
      root: "themes/company",
      connectionId: "selected-connection",
      repositoryId: 42,
    },
    selected: ["z.txt", "a.txt"],
  });
  expect(value.source).toEqual({
    kind: "github",
    repository: "https://github.com/example/templates",
    ref: "release/stable",
    root: "themes/company",
    connectionId: "selected-connection",
    repositoryId: 42,
  });
  expect(value.selected).toEqual(["a.txt", "z.txt"]);
  expect(Object.isFrozen(value.source)).toBe(true);
  expect(Object.isFrozen(value.selected)).toBe(true);
  expect(sourceStageRequest({ source: { kind: "github", repository: "example/templates" } }).selected).toBeNull();
  expect(
    sourceStageRequest({ source: { kind: "github", repository: "example/templates" }, selected: [] }).selected,
  ).toEqual([]);
  for (const source of [
    { kind: "github", repository: "example/templates", token: "SECRET" },
    { kind: "github", repository: "https://token@github.com/example/templates" },
    { kind: "github", repository: "example/templates", repositoryId: 0 },
    { kind: "zip-upload", name: "../private.zip", bytes: 1, sha256: "a".repeat(64) },
    { kind: "zip-upload", name: "archive.zip", bytes: 1, sha256: "a".repeat(64), connectionId: "hidden" },
  ])
    expect(() => sourceStageRequest({ source })).toThrow();
  for (const selected of [["a", "A"], ["a", "a/child"], ["../private"], [42]])
    expect(() =>
      sourceStageRequest({ source: { kind: "github", repository: "example/templates" }, selected }),
    ).toThrow();
  expect(() => stageId("../private")).toThrow("stageInvalidInput");
  expect(() => stagePurpose("execute")).toThrow("stageInvalidInput");
});
