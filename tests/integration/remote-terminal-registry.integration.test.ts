import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteRegistry } from "../../src/server/remote-terminal/registry.js";

test("remote profiles persist encrypted credentials and replay only within the authenticated owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-remote-"));
  let registry = new RemoteRegistry(root);
  const input = {
    id: randomUUID(),
    version: 0,
    operationId: randomUUID(),
    name: "Loopback test",
    host: "127.0.0.1",
    port: 22,
    username: "test",
    hostKey: "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=+$/, ""),
    credential: { method: "password", password: "fixture-private-password" },
  };
  try {
    const concurrent = await Promise.all([registry.save("owner-one", input), registry.save("owner-one", input)]);
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(registry.list("owner-one")).toHaveLength(1);
    expect(registry.list("owner-two")).toEqual([]);
    await expect(registry.connection("owner-two", input.id)).rejects.toThrow("notFound");
    expect(() => registry.remove("owner-two", input.id, 1)).toThrow("notFound");
    await expect(
      registry.save("owner-one", {
        ...input,
        version: 1,
        operationId: randomUUID(),
        host: "127.0.0.2",
        credential: undefined,
      }),
    ).rejects.toThrow("missingCredential");
    const renamed = await registry.save("owner-one", {
      ...input,
      version: 1,
      operationId: randomUUID(),
      name: "Renamed",
      credential: undefined,
    });
    expect(renamed.connection.version).toBe(2);
    expect(JSON.stringify(renamed)).not.toContain(input.credential.password);
    registry.close();
    expect(await readFile(join(root, "data", "remote-terminals.sqlite"), "utf8")).not.toContain(
      input.credential.password,
    );
    registry = new RemoteRegistry(root);
    expect((await registry.connection("owner-one", input.id)).secret).toEqual(input.credential);
    registry.remove("owner-one", input.id, 2);
    expect(registry.list("owner-one")).toEqual([]);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
