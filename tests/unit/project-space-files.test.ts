import { expect, test } from "bun:test";
import {
  decodeProjectSpace,
  encodeProjectSpace,
  decodeSpaceRecord,
} from "../../src/server/project-content/space-file.js";
import { decodeProjectManifest, encodeProjectManifest } from "../../src/server/project-content/project-manifest.js";
import { inspectContentHeader } from "../../src/server/project-content/header-reader.js";
import { contentCommand, contentChanges } from "../../src/server/project-content/mutation.js";
import { projectSpaceFixture, projectSpaceProfile } from "../support/project-space-fixture.js";

test("space files retain complete configuration and stable project membership without normalizing source bindings", () => {
  const value = projectSpaceFixture();
  value.space.sourceMode = "external";
  value.space.sourceRoot = "/mounted/source/原始目录";
  value.sourceProfile = projectSpaceProfile();
  expect(decodeProjectSpace(encodeProjectSpace(value))).toEqual(value);
  const root = {
    schema: 1 as const,
    projectId: "project-1",
    version: 3,
    librarySpaceId: "library",
    spaceIds: ["library", "space-1"],
  };
  expect(decodeProjectManifest(encodeProjectManifest(root))).toEqual(root);
});

test("large publication profiles do not enter bounded space metadata parsing", async () => {
  const value = projectSpaceFixture();
  value.sourceProfile = projectSpaceProfile(true);
  const bytes = Buffer.from(encodeProjectSpace(value));
  expect(bytes.length).toBeGreaterThan(500000);
  for (const short of [65536, 7]) {
    let read = 0;
    const result = await inspectContentHeader(
      {
        size: bytes.length,
        async read(offset, length) {
          const part = bytes.subarray(offset, offset + Math.min(length, short));
          read += part.length;
          return part;
        },
      },
      "space",
      decodeSpaceRecord,
    );
    expect(result.record).toEqual(value.space);
    expect(read).toBeLessThan(8192);
  }
});

test("closed space and manifest codecs reject coerced enums, secret configuration and inconsistent identities", () => {
  const valid = projectSpaceFixture();
  for (const modify of [
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.space.engine = ["hexo"];
    },
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.space.sourceMode = ["managed"];
    },
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.space.id = "../foreign";
    },
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.space.version = 0;
    },
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.sourceProfile = { ...projectSpaceProfile(), token: "example-only" };
    },
    (v: { space: Record<string, unknown>; [key: string]: unknown }) => {
      v.unexpected = true;
    },
  ]) {
    const next = JSON.parse(JSON.stringify(valid)) as { space: Record<string, unknown>; [key: string]: unknown };
    modify(next);
    expect(() => decodeProjectSpace(JSON.stringify(next))).toThrow("invalidFile");
  }
  expect(() => decodeProjectSpace(new Uint8Array([255]))).toThrow("invalidFile");
  expect(() => decodeProjectSpace(JSON.stringify({ ...valid, schema: 2 }))).toThrow("unsupportedSchema");
  for (const ids of [["one", "one"], ["../escape"], []])
    expect(() =>
      decodeProjectManifest(
        JSON.stringify({ schema: 1, projectId: "project-1", version: 1, librarySpaceId: "one", spaceIds: ids }),
      ),
    ).toThrow("invalidFile");
});

test("content commands preserve the legacy author shape and capture immutable change buffers", () => {
  const author = { name: "Author", email: "author@example.test", ignored: "outside contract" },
    command = contentCommand({ operationId: "operation", author, message: "Save metadata" });
  author.name = "Changed";
  expect(command.author).toEqual({ name: "Author", email: "author@example.test" });
  const bytes = Buffer.from("original"),
    changes = contentChanges([{ path: "tree.json", content: bytes }]);
  bytes.fill(0);
  expect(changes[0]!.content?.toString()).toBe("original");
  expect(() =>
    contentChanges([
      { path: "tree.json", content: "a" },
      { path: "tree.json", content: "b" },
    ]),
  ).toThrow("invalidFile");
});

test("space encoding refuses a record whose escaped header would be unreadable by the metadata port", () => {
  const value = projectSpaceFixture();
  value.space.sourceRoot = "\x01".repeat(16384);
  expect(() => encodeProjectSpace(value)).toThrow("invalidFile");
});
