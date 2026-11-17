import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CreationAuthoredFileVersions } from "../../src/server/creation/integration/authored-file-versions.js";
import { authoredVersionKey } from "../../src/server/creation/integration/authored-file-version-records.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creation-file-versions-")),
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
test("successive writing rounds update one filename; old receipts replay without rolling back later source", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFileVersions(f.state),
      first = randomUUID(),
      second = randomUUID(),
      third = randomUUID();
    await files.write("owner", first, f.directory, "requirements.md", "# 原文档\n");
    const receipt = await files.write("owner", second, f.directory, "requirements.md", "# 更新后的原文档\n", first);
    await files.write("owner", third, f.directory, "requirements.md", "# 再次补充\n", second);
    expect(
      await new CreationAuthoredFileVersions(f.state).write(
        "owner",
        second,
        f.directory,
        "requirements.md",
        "# 更新后的原文档\n",
        first,
      ),
    ).toEqual(receipt);
    expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe("# 再次补充\n");
    expect(await readdir(f.cwd)).toEqual(["requirements.md"]);
    expect((await files.current("owner", third, f.directory)).id).toBe(third);
    await expect(
      files.write("owner", second, f.directory, "requirements.md", "Changed replay\n", first),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      files.write("owner", randomUUID(), f.directory, "requirements.md", "Stale branch\n", first),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readdir(f.cwd)).toEqual(["requirements.md"]);
  } finally {
    await f.close();
  }
});
test("unknown destinations and manual changes are preserved, including equal foreign bytes and symlinks", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFileVersions(f.state),
      id = randomUUID();
    await writeFile(join(f.cwd, "foreign.md"), "Exact requested bytes\n");
    await expect(
      files.write("owner", randomUUID(), f.directory, "foreign.md", "Exact requested bytes\n"),
    ).rejects.toThrow("conflict");
    await files.write("owner", id, f.directory, "requirements.md", "Owned old text\n");
    await writeFile(join(f.cwd, "requirements.md"), "Manual edit must survive\n");
    await expect(
      files.write("owner", randomUUID(), f.directory, "requirements.md", "New generated text\n", id),
    ).rejects.toThrow("conflict");
    await expect(files.current("owner", id, f.directory)).rejects.toThrow("conflict");
    expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe("Manual edit must survive\n");
    await symlink(join(f.cwd, "foreign.md"), join(f.cwd, "linked.md"));
    await expect(files.write("owner", randomUUID(), f.directory, "linked.md", "Other text\n")).rejects.toThrow();
    expect(await readFile(join(f.cwd, "foreign.md"), "utf8")).toBe("Exact requested bytes\n");
  } finally {
    await f.close();
  }
});
test("independent instances share physical leases during initialization, replay and competing updates", async () => {
  const f = await fixture();
  try {
    const one = new CreationAuthoredFileVersions(f.state),
      two = new CreationAuthoredFileVersions(f.state),
      first = randomUUID(),
      second = randomUUID();
    const initial = await Promise.all([
      one.write("owner", first, f.directory, "requirements.md", "Initial\n"),
      two.write("owner", first, f.directory, "requirements.md", "Initial\n"),
    ]);
    expect(initial[0]).toEqual(initial[1]);
    const repeated = await Promise.all([
      one.write("owner", second, f.directory, "requirements.md", "Updated\n", first),
      two.write("owner", second, f.directory, "requirements.md", "Updated\n", first),
    ]);
    expect(repeated[0]).toEqual(repeated[1]);
    const branches = await Promise.allSettled([
      one.write("owner", randomUUID(), f.directory, "requirements.md", "Branch A\n", second),
      two.write("owner", randomUUID(), f.directory, "requirements.md", "Branch B\n", second),
    ]);
    expect(branches.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(branches.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(["Branch A\n", "Branch B\n"]).toContain(await readFile(join(f.cwd, "requirements.md"), "utf8"));
  } finally {
    await f.close();
  }
});
test("a user file created during replacement is never overwritten and the prior source remains recoverable", async () => {
  const f = await fixture();
  try {
    const first = randomUUID(),
      second = randomUUID(),
      path = join(f.cwd, "requirements.md"),
      files = new CreationAuthoredFileVersions(f.state, async (step) => {
        if (step === "backed-up") await writeFile(path, "New user file\n", { flag: "wx" });
      });
    await files.write("owner", first, f.directory, "requirements.md", "Prior source\n");
    await expect(
      files.write("owner", second, f.directory, "requirements.md", "Generated update\n", first),
    ).rejects.toThrow("conflict");
    expect(await readFile(path, "utf8")).toBe("New user file\n");
    const backup = (await readdir(f.cwd)).find((name) => name.endsWith(".previous.md"));
    expect(backup).toBeDefined();
    expect(await readFile(join(f.cwd, backup!), "utf8")).toBe("Prior source\n");
  } finally {
    await f.close();
  }
});
test("revocation after taking a filename restores its previous source before returning failure", async () => {
  const f = await fixture();
  let allowed = true;
  try {
    const first = randomUUID(),
      second = randomUUID(),
      directory = {
        path: f.cwd,
        verify: async () => {
          if (!allowed) throw Error("Revoked");
        },
      },
      files = new CreationAuthoredFileVersions(f.state, async (step) => {
        if (step === "backed-up") allowed = false;
      });
    await files.write("owner", first, directory, "requirements.md", "Prior source\n");
    await expect(files.write("owner", second, directory, "requirements.md", "Updated\n", first)).rejects.toThrow(
      "Revoked",
    );
    expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe("Prior source\n");
    allowed = true;
    await new CreationAuthoredFileVersions(f.state).write(
      "owner",
      second,
      directory,
      "requirements.md",
      "Updated\n",
      first,
    );
    expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe("Updated\n");
    expect(await readdir(f.cwd)).toEqual(["requirements.md"]);
    expect(await files.receipt("other-owner", first)).toBeNull();
  } finally {
    await f.close();
  }
});
test("temporary-path collisions and files created after completed cleanup remain untouched", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFileVersions(f.state),
      first = randomUUID(),
      second = randomUUID(),
      conflicting = randomUUID();
    await files.write("owner", first, f.directory, "requirements.md", "Initial\n");
    const conflictName = ".panda-authored-" + authoredVersionKey("owner", conflicting) + ".previous.md";
    await writeFile(join(f.cwd, conflictName), "Initial\n");
    await expect(files.write("owner", conflicting, f.directory, "requirements.md", "Updated\n", first)).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(join(f.cwd, conflictName), "utf8")).toBe("Initial\n");
    await files.write("owner", second, f.directory, "requirements.md", "Updated\n", first);
    const stem = ".panda-authored-" + authoredVersionKey("owner", second);
    await writeFile(join(f.cwd, stem + ".md"), "Updated\n");
    await writeFile(join(f.cwd, stem + ".previous.md"), "Initial\n");
    await files.write("owner", second, f.directory, "requirements.md", "Updated\n", first);
    expect(await readFile(join(f.cwd, stem + ".md"), "utf8")).toBe("Updated\n");
    expect(await readFile(join(f.cwd, stem + ".previous.md"), "utf8")).toBe("Initial\n");
  } finally {
    await f.close();
  }
});
for (const step of ["backed-up", "published", "receipted"])
  test(`process exit after ${step} resumes the same update without duplicate files`, async () => {
    const f = await fixture();
    try {
      const first = randomUUID(),
        second = randomUUID(),
        files = new CreationAuthoredFileVersions(f.state);
      await files.write("owner", first, f.directory, "requirements.md", "Initial\n");
      const script = join(f.root, "crash.ts"),
        module = new URL("../../src/server/creation/integration/authored-file-versions.ts", import.meta.url).pathname;
      await writeFile(
        script,
        `import {CreationAuthoredFileVersions} from ${JSON.stringify(module)};\nconst [state,cwd,id,previous,phase]=process.argv.slice(2);const files=new CreationAuthoredFileVersions(state,async(step)=>{if(step===phase)process.exit(73);});await files.write("owner",id,{path:cwd,verify:async()=>{}},"requirements.md","Updated\\n",previous);\n`,
      );
      const child = Bun.spawn([process.execPath, script, f.state, f.cwd, second, first, step], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited,
        diagnostic = await new Response(child.stderr).text();
      expect(exit, diagnostic).toBe(73);
      const recovered = await new CreationAuthoredFileVersions(f.state).write(
        "owner",
        second,
        f.directory,
        "requirements.md",
        "Updated\n",
        first,
      );
      expect(recovered.id).toBe(second);
      expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe("Updated\n");
      expect(await readdir(f.cwd)).toEqual(["requirements.md"]);
    } finally {
      await f.close();
    }
  }, 30000);

test("legacy discovery uses only matching owner/path-bound version receipts and preserves manual edits", async () => {
  const f = await fixture();
  try {
    const files = new CreationAuthoredFileVersions(f.state),
      first = randomUUID(),
      next = randomUUID();
    const base = await files.write("owner", first, f.directory, "requirements.md", "Initial\n");
    const current = await files.write("owner", next, f.directory, "requirements.md", "Current authored text\n", first);
    expect(await files.discover("owner", base, f.directory)).toEqual(current);
    await expect(files.discover("another-owner", base, f.directory)).rejects.toThrow();
    await writeFile(join(f.cwd, "requirements.md"), "Manual correction without an authored receipt\n");
    await expect(files.discover("owner", base, f.directory)).rejects.toThrow("conflict");
    expect(await readFile(join(f.cwd, "requirements.md"), "utf8")).toBe(
      "Manual correction without an authored receipt\n",
    );
  } finally {
    await f.close();
  }
});
