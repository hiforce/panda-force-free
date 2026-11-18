import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, symlink, stat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";

test("optional storage reads create no state; independent writers publish one complete immutable generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-private-store-cas-")),
    path = join(root, "private"),
    a = new PrivateStorageFiles(path),
    b = new PrivateStorageFiles(path);
  try {
    expect(await a.read(["config", "0000000001.json"])).toBeNull();
    expect(await a.list(["config"])).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    const results = await Promise.all([
      a.writeOnce(["config", "0000000001.json"], { revision: 1, value: "first" }),
      b.writeOnce(["config", "0000000001.json"], { revision: 1, value: "second" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = await a.read(["config", "0000000001.json"]);
    expect(await b.read(["config", "0000000001.json"])).toEqual(saved);
    expect(await a.list(["config"])).toEqual(["0000000001.json"]);
    expect((await stat(join(path, "config", "0000000001.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, "config"))).mode & 0o777).toBe(0o700);
    const reopened = new PrivateStorageFiles(path);
    expect(await reopened.installation()).toBe(await a.installation());
    expect(await reopened.scope("owner/project")).toBe(await a.scope("owner/project"));
    expect(await reopened.scope("another-owner/project")).not.toBe(await a.scope("owner/project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable configuration CAS also excludes a separate process without a project or database lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-private-store-process-")),
    path = join(root, "private");
  try {
    const module = new URL("../../src/server/object-storage/private-files.ts", import.meta.url).pathname;
    const code = `import {PrivateStorageFiles} from ${JSON.stringify(module)};const result=await new PrivateStorageFiles(process.argv[1]).writeOnce(['config','0000000001.json'],{revision:1,writer:process.pid});process.stdout.write(JSON.stringify(result));`;
    const children = [1, 2].map(() =>
      Bun.spawn([process.execPath, "--eval", code, path], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [output, diagnostic, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, diagnostic).toBe(0);
        return JSON.parse(output);
      }),
    );
    expect(results.sort()).toEqual([false, true]);
    expect(await new PrivateStorageFiles(path).read(["config", "0000000001.json"])).toMatchObject({ revision: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinks and lost ownership cannot redirect private configuration or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-private-store-boundary-")),
    path = join(root, "private"),
    outside = join(root, "unrelated"),
    files = new PrivateStorageFiles(path);
  try {
    await mkdir(outside, { mode: 0o700 });
    await files.installation();
    await symlink(outside, join(path, "credentials"));
    await expect(files.writeOnce(["credentials", "test.json"], { secret: "must not escape" })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await expect(files.writeOnce(["..", "test.json"], {})).rejects.toThrow();
    await writeFile(join(path, "ownership.json"), "{}\n");
    await expect(files.installation()).rejects.toMatchObject({ code: "storageIntegrity" });
    await expect(files.read(["config", "missing.json"])).rejects.toMatchObject({ code: "storageIntegrity" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
