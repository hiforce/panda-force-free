import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CreationGeneratedOriginals,
  CreationCandidateChanged,
} from "../../src/server/creation/integration/rendering/generated-originals.js";

test("generated originals coalesce identical calls, survive restart and reject changed candidate input and foreign ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-originals-"));
  try {
    const store = new CreationGeneratedOriginals(root),
      input = {
        owner: "owner",
        taskId: randomUUID(),
        contextDigest: "a".repeat(64),
        kind: "web" as const,
        slot: 1,
        signature: "b".repeat(64),
      },
      bytes = Buffer.from("<!doctype html><html><h1>Actual HTML</h1></html>"),
      resource = Buffer.from("Owned resource"),
      authorize = async () => {};
    let calls = 0;
    const render = async () => {
      calls++;
      await Bun.sleep(10);
      return {
        kind: "web" as const,
        name: "index.html",
        bytes,
        resources: [{ name: "resource.txt", bytes: resource }],
      };
    };
    const handles = await Promise.all(Array.from({ length: 8 }, () => store.render(input, render, authorize)));
    expect(new Set(handles).size).toBe(1);
    expect(calls).toBe(1);
    const key = handles[0]!,
      restarted = new CreationGeneratedOriginals(root);
    expect(await restarted.render(input, render, authorize)).toBe(key);
    expect(calls).toBe(1);
    const saved = await restarted.resolve(input.owner, input.taskId, "web", key);
    expect(saved.bytes).toEqual(bytes);
    expect(saved.resources).toEqual([{ name: "resource.txt", bytes: resource }]);
    await expect(restarted.render({ ...input, signature: "c".repeat(64) }, render, authorize)).rejects.toBeInstanceOf(
      CreationCandidateChanged,
    );
    await expect(restarted.resolve("foreign", input.taskId, "web", key)).rejects.toThrow();
    await expect(restarted.resolve(input.owner, randomUUID(), "web", key)).rejects.toThrow();
    await expect(restarted.resolve(input.owner, input.taskId, "slides", key)).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoked authority prevents generated receipt admission and recovery retains the immutable candidate identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-originals-"));
  try {
    const store = new CreationGeneratedOriginals(root),
      input = {
        owner: "owner",
        taskId: randomUUID(),
        contextDigest: "a".repeat(64),
        kind: "web" as const,
        slot: 1,
        signature: "b".repeat(64),
      },
      original = { kind: "web" as const, name: "index.html", bytes: Buffer.from("<html>Actual</html>") };
    let allowed = true,
      calls = 0;
    const authorize = async () => {
      if (!allowed) throw Error("Permission revoked");
    };
    await expect(
      store.render(
        input,
        async () => {
          calls++;
          allowed = false;
          return original;
        },
        authorize,
      ),
    ).rejects.toThrow("Permission revoked");
    allowed = true;
    const key = await store.render(
      input,
      async () => {
        calls++;
        return original;
      },
      authorize,
    );
    expect((await store.resolve(input.owner, input.taskId, "web", key)).bytes).toEqual(original.bytes);
    expect(calls).toBe(2);
    await expect(
      store.render(
        { ...input, slot: 2 },
        async () => ({
          ...original,
          resources: [
            { name: "A.png", bytes: Buffer.from("a") },
            { name: "a.png", bytes: Buffer.from("b") },
          ],
        }),
        authorize,
      ),
    ).rejects.toThrow();
    await expect(
      store.render({ ...input, slot: 3 }, async () => ({ ...original, name: "../outside.html" }), authorize),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
