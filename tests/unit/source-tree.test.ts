import { expect, test } from "bun:test";
import { DEFAULT_SOURCE_LIMITS, SourceError } from "../../src/shared/packages/sources/contracts.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { SourcePaths, sourcePath } from "../../src/shared/packages/sources/paths.js";

const text = (value: string) => new TextEncoder().encode(value);

test("logical entry budgets include implicit directories instead of counting only archive records", async () => {
  const limits = { ...DEFAULT_SOURCE_LIMITS, entries: 2 };
  await expect(ImmutableSourceTree.create([{ path: "a/b/c", bytes: text("x") }], limits)).rejects.toThrow(
    "sourceTooLarge",
  );
});

test("source trees own bytes before asynchronous hashing and expose immutable path-bound identities", async () => {
  const bytes = text("Original source"),
    resource = { path: "theme/layout/index.ejs", bytes };
  const pending = ImmutableSourceTree.create([resource]);
  bytes.fill(0);
  resource.path = "changed";
  resource.bytes = text("Changed");
  const tree = await pending;
  expect(tree.text("theme/layout/index.ejs")).toBe("Original source");
  tree.read("theme/layout/index.ejs").fill(0);
  expect(tree.text("theme/layout/index.ejs")).toBe("Original source");
  expect(Object.isFrozen(tree)).toBe(true);
  expect(Object.isFrozen(tree.files)).toBe(true);
  expect(Object.isFrozen(tree.files[0])).toBe(true);
  expect(tree.digest).toMatch(/^[a-f0-9]{64}$/);
  const renamed = await ImmutableSourceTree.create([{ path: "different.ejs", bytes: text("Original source") }]);
  expect(renamed.digest).not.toBe(tree.digest);
  expect(tree.has("missing")).toBe(false);
  expect(() => tree.read("missing")).toThrow("sourceUnavailable");
});

test("source identities ignore acquisition order and retain exact UTF-8 filenames and binary files", async () => {
  const resources = [
    { path: "目录/é.txt", bytes: text("A") },
    { path: "image.png", bytes: new Uint8Array([0, 255, 4]) },
  ];
  const first = await ImmutableSourceTree.create(resources),
    second = await ImmutableSourceTree.create([...resources].reverse());
  expect(first.digest).toBe(second.digest);
  expect(first.files.map((file) => file.path)).toEqual(["image.png", "目录/é.txt"]);
  expect(first.read("image.png")).toEqual(new Uint8Array([0, 255, 4]));
  expect(() => first.text("image.png")).toThrow("invalidSource");
  expect(() => first.text("目录/é.txt", 0)).toThrow("sourceTooLarge");
});

test("logical paths reject traversal, device aliases, ambiguous parents and duplicate archive nodes", async () => {
  for (const path of [
    "/etc/passwd",
    "../a",
    "a/../b",
    "a//b",
    "a\\b",
    "C:/data",
    "a/.",
    "NUL.txt",
    "a/COM1",
    "a. ",
    "a/%2e%2e/b",
    "a/\u202Etxt",
    "\ud800.txt",
    "文".repeat(86),
  ])
    expect(() => sourcePath(path), path).toThrow(SourceError);
  for (const paths of [
    ["a", "a/b"],
    ["a/b", "a"],
    ["a/x", "A/y"],
    ["é/x", "e\u0301/y"],
    ["same", "same"],
  ])
    await expect(ImmutableSourceTree.create(paths.map((path) => ({ path, bytes: text(path) })))).rejects.toThrow(
      "duplicateSourcePath",
    );
  const paths = new SourcePaths();
  paths.add("theme/layout/index.ejs");
  paths.add("theme", true);
  expect(() => paths.add("theme", true)).toThrow("duplicateSourcePath");
  expect(() => paths.add("theme/layout", false)).toThrow("duplicateSourcePath");
});

test("source limits bind actual file counts, bytes and bounded UTF-8 text reads", async () => {
  const options = { ...DEFAULT_SOURCE_LIMITS, files: 1, fileBytes: 4, totalBytes: 4 };
  await expect(ImmutableSourceTree.create([{ path: "a", bytes: text("12345") }], options)).rejects.toThrow(
    "sourceTooLarge",
  );
  await expect(
    ImmutableSourceTree.create(
      [
        { path: "a", bytes: text("1") },
        { path: "b", bytes: text("2") },
      ],
      options,
    ),
  ).rejects.toThrow("sourceTooLarge");
  const tree = await ImmutableSourceTree.create([{ path: "a", bytes: text("1234") }], options);
  expect(() => tree.text("a", 3)).toThrow("sourceTooLarge");
  await expect(ImmutableSourceTree.create([], { ...options, files: Infinity })).rejects.toThrow("invalidSource");
});
