import { test, expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CreationAuthoredFiles,
  creationDocumentFilename,
} from "../../src/server/creation/integration/authored-files.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creation-authored-")),
    cwd = join(root, "workspace"),
    state = join(root, "state");
  await mkdir(cwd);
  return {
    root,
    cwd,
    state,
    directory: { path: cwd, verify: async () => {} },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("authored documents retain exact UTF-8 bytes in the bound directory and converge across replay and restart", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(),
      name = creationDocumentFilename("类目字段 / 需求文档", id),
      text = "# 类目字段\n\n子类目继承父类目的字段。\n";
    const files = new CreationAuthoredFiles(f.state),
      [first, second] = await Promise.all([
        files.write("owner", id, f.directory, name, text),
        files.write("owner", id, f.directory, name, text),
      ]);
    expect(first).toEqual(second);
    expect(first.path).toBe(join(f.cwd, name));
    expect((await readFile(first.path)).toString("utf8")).toBe(text);
    expect(first.digest).toBe(createHash("sha256").update(text).digest("hex"));
    expect(await new CreationAuthoredFiles(f.state).write("owner", id, f.directory, name, text)).toEqual(first);
    expect(await readdir(f.cwd)).toEqual([name]);
  } finally {
    await f.close();
  }
});
test("pre-existing files, identical foreign files and symlink targets are preserved", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFiles(f.state),
      name = "requirements.md",
      text = "User-authored contents\n";
    await writeFile(join(f.cwd, name), text);
    await expect(files.write("owner", randomUUID(), f.directory, name, text)).rejects.toThrow("conflict");
    await expect(files.write("owner", randomUUID(), f.directory, name, "New text")).rejects.toThrow("conflict");
    await writeFile(join(f.root, "original.md"), "Original source");
    await symlink(join(f.root, "original.md"), join(f.cwd, "linked.md"));
    await expect(files.write("owner", randomUUID(), f.directory, "linked.md", "Changed source")).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(join(f.cwd, name), "utf8")).toBe(text);
    expect(await readFile(join(f.root, "original.md"), "utf8")).toBe("Original source");
  } finally {
    await f.close();
  }
});
test("an interrupted post-link receipt resumes the same file without claiming a foreign destination", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(),
      name = "requirements.md",
      text = "Frozen original\n";
    let checks = 0;
    await expect(
      new CreationAuthoredFiles(f.state).write(
        "owner",
        id,
        {
          path: f.cwd,
          verify: async () => {
            if (++checks === 4) throw Error("Access revoked");
          },
        },
        name,
        text,
      ),
    ).rejects.toThrow("Access revoked");
    expect(await readFile(join(f.cwd, name), "utf8")).toBe(text);
    const recovered = await new CreationAuthoredFiles(f.state).write("owner", id, f.directory, name, text);
    expect(recovered.path).toBe(join(f.cwd, name));
    expect(await readdir(f.cwd)).toEqual([name]);
    await expect(new CreationAuthoredFiles(f.state).write("other", id, f.directory, name, text)).rejects.toThrow(
      "conflict",
    );
  } finally {
    await f.close();
  }
});
test("a file created at publication time is never adopted even when its bytes match", async () => {
  const f = await fixture();
  try {
    let checks = 0;
    const id = randomUUID(),
      name = "requirements.md",
      text = "Identical bytes\n";
    const directory = {
      path: f.cwd,
      verify: async () => {
        if (++checks === 3) await writeFile(join(f.cwd, name), text, { flag: "wx" });
      },
    };
    await expect(new CreationAuthoredFiles(f.state).write("owner", id, directory, name, text)).rejects.toThrow(
      "conflict",
    );
    await expect(new CreationAuthoredFiles(f.state).write("owner", id, f.directory, name, text)).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(join(f.cwd, name), "utf8")).toBe(text);
  } finally {
    await f.close();
  }
});
test("frozen requests and current authorization are checked on repeated delivery", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFiles(f.state),
      id = randomUUID(),
      name = "requirements.md";
    await files.write("owner", id, f.directory, name, "Original");
    await expect(files.write("owner", id, f.directory, name, "Changed")).rejects.toThrow("conflict");
    await expect(files.write("owner", id, f.directory, "other.md", "Original")).rejects.toThrow("conflict");
    await expect(
      files.write(
        "owner",
        id,
        {
          path: f.cwd,
          verify: async () => {
            throw Error("Denied");
          },
        },
        name,
        "Original",
      ),
    ).rejects.toThrow("Denied");
    await writeFile(join(f.cwd, name), "Edited by user");
    await expect(files.write("owner", id, f.directory, name, "Original")).rejects.toThrow("conflict");
    expect(await readFile(join(f.cwd, name), "utf8")).toBe("Edited by user");
  } finally {
    await f.close();
  }
});
test("filenames cannot escape a directory and generated Unicode names remain below filesystem byte limits", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFiles(f.state);
    for (const name of [
      "../escape.md",
      "sub/file.md",
      "sub\\file.md",
      "file\0.md",
      "file:stream.md",
      "..",
      "a".repeat(241) + ".md",
    ])
      expect(() => files.write("owner", randomUUID(), f.directory, name, "Original")).toThrow("invalidInput");
    const name = creationDocumentFilename("文".repeat(200), randomUUID());
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(220);
    expect((await files.write("owner", randomUUID(), f.directory, name, "Valid file")).path).toBe(join(f.cwd, name));
    expect(await readdir(f.cwd)).toEqual([name]);
  } finally {
    await f.close();
  }
});
