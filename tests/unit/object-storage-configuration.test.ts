import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import type { OriginalStorageMutation } from "../../src/shared/storage/contracts.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-storage-settings-")),
    path = join(root, "storage"),
    files = new PrivateStorageFiles(path),
    settings = new OriginalStorageConfiguration(files);
  return { root, path, files, settings, close: () => rm(root, { recursive: true, force: true }) };
}
function initial(endpoint = "https://objects.example.test"): Extract<OriginalStorageMutation, { action: "configure" }> {
  return {
    action: "configure",
    revision: 0,
    operationId: randomUUID(),
    mode: "s3",
    kinds: ["image", "video"],
    profile: {
      label: "Originals",
      endpoint,
      region: "us-east-1",
      bucket: "private-originals",
      forcePathStyle: true,
      prefix: "private/assets",
      credentials: {
        accessKeyId: "fixture-original-access",
        secretAccessKey: "fixture-original-private",
        sessionToken: "fixture-session-token",
      },
    },
  };
}

test("absent configuration remains local, category routing is explicit and settings never return credentials", async () => {
  const f = await fixture();
  try {
    expect(await f.settings.read()).toMatchObject({ revision: 0, mode: "local", activeProfileId: null, profiles: [] });
    expect(await f.settings.writeTarget("image")).toBeNull();
    expect(await f.settings.operation(randomUUID())).toBeNull();
    expect(await readdir(f.root)).toEqual([]);
    const input = initial(),
      result = await f.settings.save(input);
    expect(result.savedRevision).toBe(1);
    expect(result.settings.profiles).toHaveLength(1);
    const json = JSON.stringify(result);
    expect(json).not.toContain("fixture-original-private");
    expect(json).not.toContain("fixture-session-token");
    expect(json).not.toContain("fixture-original-access");
    expect(result.settings.profiles[0]?.accessKeyHint).toBe("cess");
    expect((await f.settings.writeTarget("image"))?.profile.bucket).toBe("private-originals");
    expect(await f.settings.writeTarget("file")).toBeNull();
    const reopened = new OriginalStorageConfiguration(new PrivateStorageFiles(f.path));
    expect(await reopened.read()).toEqual(result.settings);
    expect(await f.settings.save(input)).toEqual(result);
    const completed = { id: input.operationId, state: "saved" as const, savedRevision: 1, currentRevision: 1 };
    expect(await reopened.operation(input.operationId)).toEqual(completed);
    await f.files.remove([
      "configuration-operations",
      input.operationId.slice(0, 2),
      input.operationId + ".saved.json",
    ]);
    expect(await reopened.operation(input.operationId)).toEqual(completed);
    expect(
      await f.files.read([
        "configuration-operations",
        input.operationId.slice(0, 2),
        input.operationId + ".saved.json",
      ]),
    ).toMatchObject({ revision: 1 });
  } finally {
    await f.close();
  }
});

test("changing bucket creates a new frozen location and old-profile credentials rotate without repointing old originals", async () => {
  const f = await fixture();
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push(request.headers.get("authorization") ?? "");
      return new Response(null, { status: 404 });
    },
  });
  try {
    const saved = await f.settings.save(initial(server.url.origin)),
      previous = saved.settings.profiles[0]!,
      location = await f.settings.client(previous.id),
      profile = { ...previous, bucket: "another-private-bucket" };
    const changed = await f.settings.save({
      action: "configure",
      revision: 1,
      operationId: randomUUID(),
      mode: "s3",
      kinds: ["image"],
      profile: {
        id: previous.id,
        label: profile.label,
        endpoint: profile.endpoint,
        region: profile.region,
        bucket: profile.bucket,
        forcePathStyle: profile.forcePathStyle,
        prefix: profile.prefix,
      },
    });
    expect(changed.settings.profiles).toHaveLength(2);
    expect(changed.settings.activeProfileId).not.toBe(previous.id);
    expect((await f.settings.client(previous.id, location.digest)).profile.bucket).toBe("private-originals");
    expect((await f.settings.writeTarget("image"))?.profile.bucket).toBe("another-private-bucket");
    const rotated = await f.settings.save({
      action: "credentials",
      revision: 2,
      operationId: randomUUID(),
      profileId: previous.id,
      credentialRevision: 1,
      credentials: { accessKeyId: "fixture-rotated-access", secretAccessKey: "fixture-rotated-private" },
    });
    expect(rotated.settings.activeProfileId).toBe(changed.settings.activeProfileId);
    expect(rotated.settings.profiles.find((value) => value.id === previous.id)?.credentialRevision).toBe(2);
    await (await f.settings.client(previous.id, location.digest)).client.head("owned/old-original");
    expect(received.at(-1)).toContain("Credential=fixture-rotated-access/");
    const local = await f.settings.save({
      action: "configure",
      revision: 3,
      operationId: randomUUID(),
      mode: "local",
      kinds: ["image"],
    });
    expect(await f.settings.writeTarget("image")).toBeNull();
    expect(local.settings.profiles).toHaveLength(2);
    expect((await f.settings.client(previous.id, location.digest)).profile.bucket).toBe("private-originals");
  } finally {
    server.stop(true);
    await f.close();
  }
});

test("racing credential saves publish only the winning secret reference and stale or changed replays cannot rotate it again", async () => {
  const f = await fixture();
  try {
    const saved = await f.settings.save(initial()),
      id = saved.settings.profiles[0]!.id,
      candidates = ["first", "second"].map((name) => ({
        action: "credentials" as const,
        revision: 1,
        operationId: randomUUID(),
        profileId: id,
        credentialRevision: 1,
        credentials: { accessKeyId: "fixture-" + name, secretAccessKey: "private-" + name },
      }));
    const other = new OriginalStorageConfiguration(new PrivateStorageFiles(f.path));
    const results = await Promise.allSettled([f.settings.save(candidates[0]), other.save(candidates[1])]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const current = await f.settings.read(),
      index = candidates.findIndex((value) => value.operationId === current.operationId);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(current.profiles[0]?.credentialRevision).toBe(2);
    const record = (await f.files.read(["config", "0000000002.json"])) as { profiles: { credentialId: string }[] };
    expect(record.profiles[0]?.credentialId).toBe(candidates[index]!.operationId);
    const secret = (await f.files.read(["credentials", id, candidates[index]!.operationId + ".json"])) as {
      credentials: unknown;
    };
    expect(secret.credentials).toEqual(candidates[index]!.credentials);
    await expect(
      f.settings.save({ ...candidates[index], credentials: { accessKeyId: "changed", secretAccessKey: "changed" } }),
    ).rejects.toMatchObject({ code: "storageConflict" });
    await f.settings.save(candidates[index]);
    expect((await f.settings.read()).revision).toBe(2);
    await expect(f.settings.save({ ...candidates[index], revision: 2, credentialRevision: 2 })).rejects.toMatchObject({
      code: "storageConflict",
    });
  } finally {
    await f.close();
  }
});

test("invalid configuration cannot initialize storage or reuse a kept secret at another endpoint", async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { ...initial(), kinds: [] },
      { ...initial(), revision: -1 },
      { ...initial(), secret: "unknown" },
      { ...initial(), profile: { ...initial().profile, prefix: "../outside" } },
    ])
      await expect(f.settings.save(invalid)).rejects.toMatchObject({ code: "storageInvalidConfiguration" });
    expect(await readdir(f.root)).toEqual([]);
    const saved = await f.settings.save(initial()),
      old = saved.settings.profiles[0]!;
    await expect(
      f.settings.save({
        action: "configure",
        revision: 1,
        operationId: randomUUID(),
        mode: "s3",
        kinds: ["image"],
        profile: {
          id: old.id,
          label: old.label,
          endpoint: "https://other.example.test",
          region: old.region,
          bucket: old.bucket,
          forcePathStyle: old.forcePathStyle,
          prefix: old.prefix,
        },
      }),
    ).rejects.toMatchObject({ code: "storageInvalidConfiguration" });
    expect((await f.settings.read()).revision).toBe(1);
    const automatic = initial("");
    automatic.revision = 1;
    automatic.profile!.credentials!.sessionToken = "";
    const changed = await f.settings.save(automatic);
    expect(changed.settings.profiles.at(-1)?.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
  } finally {
    await f.close();
  }
});
