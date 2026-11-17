import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creationCodeDirectories } from "../../src/server/creation/integration/code-directories.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";

const task = { owner: "owner", projectId: "personal" } as CreationTaskSpec;
test("directory grants freeze every component and reject symlinks, replaced parents, external roots and revoked principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-code-grants-"));
  let allowed = true;
  try {
    const code = join(root, "code"),
      docs = join(code, "nested", "docs");
    await mkdir(docs, { recursive: true });
    const directories = creationCodeDirectories({
      root: async () => code,
      authorize: async (input) => {
        if (!allowed || input.owner !== "owner") throw Error("Revoked");
      },
    });
    expect((await directories.describe(task)).root).toBe(code);
    const grant = await directories.open(task, "nested/docs");
    await grant.verify();
    expect((await directories.open(task, docs)).identity).toBe(grant.identity);
    await expect(directories.open(task, "../elsewhere")).rejects.toThrow();
    await expect(directories.open(task, ".git")).rejects.toThrow();
    await symlink(docs, join(code, "alias"));
    await expect(directories.open(task, "alias")).rejects.toThrow();
    await rename(join(code, "nested"), join(code, "original"));
    await mkdir(docs, { recursive: true });
    await expect(grant.verify()).rejects.toThrow();
    expect((await directories.open(task, "nested/docs")).identity).not.toBe(grant.identity);
    allowed = false;
    await expect(directories.describe(task)).rejects.toThrow("Revoked");
    await expect(directories.open(task, "nested/docs")).rejects.toThrow("Revoked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
