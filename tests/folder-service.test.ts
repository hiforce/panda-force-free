import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "bun:test";
import { defaultBrowseRoots, isDirectory, listFolders, resolveBrowsePath } from "../src/server/workspace/folders.js";

const root = mkdtempSync(join(tmpdir(), "panda-force-folders-"));
mkdirSync(join(root, "alpha"));
mkdirSync(join(root, "Beta"));
mkdirSync(join(root, ".hidden"));
mkdirSync(join(root, "alpha", "nested"));
writeFileSync(join(root, "file.txt"), "not a directory");
const outside = mkdtempSync(join(tmpdir(), "panda-force-outside-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveBrowsePath", () => {
  test("expands ~ to the provided home inside allowed roots", () => {
    expect(resolveBrowsePath("~", [root], root)).toBe(root);
    expect(resolveBrowsePath("~/alpha", [root], root)).toBe(join(root, "alpha"));
  });

  test("accepts absolute paths inside allowed roots", () => {
    expect(resolveBrowsePath(join(root, "alpha"), [root], root)).toBe(join(root, "alpha"));
  });

  test("rejects paths outside allowed roots", () => {
    expect(() => resolveBrowsePath(outside, [root], root)).toThrow("outside allowed roots");
    expect(() => resolveBrowsePath("/", [root], root)).toThrow("outside allowed roots");
    expect(() => resolveBrowsePath(join(root, "..", "elsewhere"), [root], root)).toThrow("outside allowed roots");
  });

  test("rejects symlinks escaping the root after canonicalization", () => {
    symlinkSync(outside, join(root, "escape"));
    try {
      expect(() => resolveBrowsePath(join(root, "escape"), [root], root)).toThrow("outside allowed roots");
    } finally {
      rmSync(join(root, "escape"), { force: true });
    }
  });
});

describe("listFolders", () => {
  test("lists visible directories sorted case-insensitively, skipping files and dotfolders", () => {
    const result = listFolders(root, [root]);
    expect(result.path).toBe(root);
    expect(result.folders.map((folder: any) => folder.name)).toEqual(["alpha", "Beta"]);
    expect(result.folders[0].path).toBe(join(root, "alpha"));
  });

  test("reports the parent only while it stays inside the allowed roots", () => {
    expect(listFolders(join(root, "alpha"), [root]).parent).toBe(root);
    expect(listFolders(root, [root]).parent).toBeNull();
  });
});

describe("defaultBrowseRoots / isDirectory", () => {
  test("defaultBrowseRoots resolves the home directory", () => {
    expect(defaultBrowseRoots(root)).toEqual([resolve(root)]);
  });

  test("isDirectory distinguishes directories, files and missing paths", () => {
    expect(isDirectory(root)).toBe(true);
    expect(isDirectory(join(root, "file.txt"))).toBe(false);
    expect(isDirectory(join(root, "missing"))).toBe(false);
  });
});
