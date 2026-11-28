import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OAuthHttp } from "../../src/server/connections/oauth/http.js";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import { GoogleStorageConsent } from "../../src/server/object-storage/google-consent.js";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";
import { StorageRegistration } from "../../src/server/object-storage/registration.js";
import { googleStorageCallbackPath } from "../../src/shared/workspace-tools/storage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-storage-registration-"));
  roots.push(root);
  const path = join(root, "original-storage");
  const files = new PrivateStorageFiles(path);
  const original = new OriginalStorageConfiguration(files);
  return { path, original, storage: new StorageRegistration(files, original) };
}

test("registers reusable S3 and OSS without changing original assignments, coalesces retries, and seals secrets", async () => {
  const { original, storage, path } = await fixture();
  const credentials = { accessKeyId: "testAccess987", secretAccessKey: "testSecret321" };
  await original.save({
    action: "configure",
    mode: "s3",
    kinds: ["image"],
    revision: 0,
    operationId: randomUUID(),
    profile: {
      label: "Existing originals",
      bucket: "existing-originals-bucket",
      region: "eu-west-1",
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      prefix: "originals",
      forcePathStyle: false,
      credentials,
    },
  });
  const before = await original.read();
  const input = {
    id: randomUUID(),
    name: "Commerce backup",
    provider: "s3",
    region: "eu-west-1",
    bucket: "commerce-backup",
    prefix: "daily/import",
    forcePathStyle: true,
    ...credentials,
  };
  const [first, second] = await Promise.all([storage.addObjectStorage(input), storage.addObjectStorage(input)]);
  expect(second).toEqual(first);
  expect(first).toMatchObject({ endpoint: "https://s3.eu-west-1.amazonaws.com", forcePathStyle: true });
  expect(
    await storage.addObjectStorage({
      ...input,
      id: randomUUID(),
      provider: "oss",
      name: "Design archive",
      bucket: "design-archive",
      region: "cn-hangzhou",
    }),
  ).toMatchObject({ endpoint: "https://s3.oss-cn-hangzhou.aliyuncs.com", forcePathStyle: false });
  await expect(storage.addObjectStorage({ ...input, name: "Different request" })).rejects.toMatchObject({
    code: "storageConflict",
  });
  await expect(
    storage.addObjectStorage({ ...input, id: randomUUID(), endpoint: "https://user:pass@example.test" }),
  ).rejects.toMatchObject({ code: "storageInvalidConfiguration" });
  const listed = await storage.list();
  expect(listed.map((entry) => entry.provider)).toEqual(["s3", "oss", "s3"]);
  expect(listed.at(-1)).toMatchObject({ id: before.activeProfileId, originalStorage: "active" });
  expect(await original.read()).toEqual(before);
  const bytes = await readFile(join(path, "registered-connections", input.id + ".json"), "utf8");
  expect(bytes.includes(credentials.accessKeyId)).toBe(false);
  expect(bytes.includes(credentials.secretAccessKey)).toBe(false);
  const { secret } = JSON.parse(bytes);
  expect(await storage.cipher.open(storage.binding(input.id, "s3"), secret)).toEqual(credentials);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
});

test("Google registration uses bounded PKCE consent, checks host and session, and protects refresh tokens against replay", async () => {
  const { storage, path } = await fixture();
  let exchanges = 0;
  const consent = new GoogleStorageConsent(
    storage,
    new OAuthHttp(async (url, options) => {
      if (url === "https://oauth2.googleapis.com/token") {
        exchanges++;
        const body = options?.body as URLSearchParams;
        expect(body.get("code")).toBe("fixture-code");
        expect(body.get("code_verifier")).toHaveLength(43);
        expect(body.get("redirect_uri")).toBe("https://panda.example.test" + googleStorageCallbackPath);
        return Response.json({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          scope: "https://www.googleapis.com/auth/drive.file",
        });
      }
      expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/about/);
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-access");
      return Response.json({ user: { emailAddress: "owner@example.test" } });
    }),
  );
  const id = randomUUID(),
    input = {
      id,
      name: "My Google Drive",
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "fixture-client-secret",
    },
    origin = "https://panda.example.test",
    session = "browser-session-a",
    start = new URL(await consent.begin(input, origin, session));
  expect(start.origin).toBe("https://accounts.google.com");
  expect(start.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.searchParams.get("access_type")).toBe("offline");
  expect(start.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  const query = new URLSearchParams({ state: start.searchParams.get("state")!, code: "fixture-code" });
  expect(await consent.finish(query, "panda.example.test", "wrong-session")).toBe("expired");
  expect(await consent.finish(query, "different.example.test", session)).toBe("expired");
  const finishes = await Promise.all([
    consent.finish(query, "panda.example.test", session),
    consent.finish(query, "panda.example.test", session),
  ]);
  expect(finishes.sort()).toEqual(["expired", "saved"]);
  expect(exchanges).toBe(1);
  expect(await storage.list()).toEqual([
    { id, provider: "google-drive", name: input.name, account: "owner@example.test" },
  ]);
  const bytes = await readFile(join(path, "registered-connections", id + ".json"), "utf8");
  expect(bytes).not.toContain("fixture-refresh");
  expect(bytes).not.toContain(input.clientSecret);
  const { secret } = JSON.parse(bytes);
  expect(await storage.cipher.open(storage.binding(id, "google-drive"), secret)).toMatchObject({
    refreshToken: "fixture-refresh",
  });
  const abandoned = new URL(await consent.begin({ ...input, id: randomUUID() }, origin, session));
  expect(
    await consent.finish(
      new URLSearchParams({ state: abandoned.searchParams.get("state")!, error: "access_denied" }),
      "panda.example.test",
      session,
    ),
  ).toBe("cancelled");
  expect(exchanges).toBe(1);
});

test("rules resolve an existing named storage destination without duplicating credentials and retain historical targets", async () => {
  const inherited = await fixture(),
    files = inherited.storage.files;
  const original = new OriginalStorageConfiguration(files, (id): ReturnType<StorageRegistration["objectTarget"]> =>
    connections.objectTarget(id),
  );
  const connections = new StorageRegistration(files, original);
  const legacyKeys = { accessKeyId: "legacyAccess", secretAccessKey: "legacySecret" },
    keys = { accessKeyId: "registeredAccess", secretAccessKey: "registeredSecret" },
    id = randomUUID(),
    drive = randomUUID();
  const legacy = await original.save({
    action: "configure",
    revision: 0,
    operationId: randomUUID(),
    mode: "s3",
    kinds: ["image"],
    profile: {
      label: "Existing",
      region: "us-east-1",
      endpoint: "",
      bucket: "legacy-bucket",
      forcePathStyle: true,
      prefix: "old",
      credentials: legacyKeys,
    },
  });
  const oldTarget = await original.writeTarget("image");
  await connections.addObjectStorage({
    id,
    name: "Selected OSS",
    provider: "oss",
    bucket: "registered-bucket",
    region: "cn-hangzhou",
    prefix: "future",
    ...keys,
  });
  await connections.save(
    { id: drive, name: "Drive", provider: "google-drive", account: "owner@example.test" },
    { refreshToken: "drive-fixture" },
  );
  await expect(
    original.save({
      action: "placement",
      revision: 1,
      operationId: randomUUID(),
      mode: "s3",
      kinds: ["image"],
      profileId: drive,
    }),
  ).rejects.toMatchObject({ code: "storageInvalidConfiguration" });
  const selected = await original.save({
    action: "placement",
    revision: 1,
    operationId: randomUUID(),
    mode: "s3",
    kinds: ["image", "project-memory-package"],
    profileId: id,
  });
  expect(selected.settings.activeProfileId).toBe(id);
  expect(selected.settings.profiles).toEqual(legacy.settings.profiles);
  const target = (await original.writeTarget("image"))!;
  expect(target.profile).toMatchObject({ id, prefix: "future", bucket: "registered-bucket" });
  expect(await original.writeTarget("video")).toBeNull();
  expect(await original.memoryPackageTarget()).toMatchObject({ profile: { id }, digest: target.digest });
  expect((await connections.list()).find((item) => item.id === id)).toMatchObject({
    originalStorage: "active",
    credentialRevision: 1,
  });
  const rotate = {
    action: "rotate",
    id,
    operationId: randomUUID(),
    credentialRevision: 1,
    credentials: { accessKeyId: "replacementAccess", secretAccessKey: "replacementSecret" },
  };
  await Promise.all([connections.rotateObject(rotate), connections.rotateObject(rotate)]);
  await expect(connections.rotateObject({ ...rotate, operationId: randomUUID() })).rejects.toMatchObject({
    code: "storageConflict",
  });
  expect(await original.client(id, target.digest)).toMatchObject({ credentialRevision: 2, digest: target.digest });
  expect(await original.read()).toEqual(selected.settings);
  await original.save({
    action: "placement",
    revision: 2,
    operationId: randomUUID(),
    mode: "local",
    kinds: ["image"],
  });
  expect(await original.writeTarget("image")).toBeNull();
  expect(await original.client(id, target.digest)).toMatchObject({ profile: { id }, credentialRevision: 2 });
  expect(await original.client(oldTarget!.profile.id, oldTarget!.digest)).toMatchObject({
    profile: { bucket: "legacy-bucket" },
    credentialRevision: 1,
  });
  const filesOnDisk = await readFile(join(inherited.path, "registered-connection-keys", id, "0000000002.json"), "utf8");
  expect(filesOnDisk).not.toContain(rotate.credentials.secretAccessKey);
});
