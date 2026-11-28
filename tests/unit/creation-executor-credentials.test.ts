import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaBrokerClient, serveMediaBroker } from "../../src/server/creation/integration/media-executors/broker.js";
import { CreationMediaExecutors } from "../../src/server/creation/integration/media-executors/service.js";
import { mediaBinding } from "../../src/server/creation/media-executors/selection.js";

const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEElEQVR4nGP4z8AARAzYKAB3pAf53le34gAAAABJRU5ErkJggg==";
const image = Buffer.from(encoded, "base64");

test("named credentials are private, reusable, fenced on replacement and revocable through the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-executor-keys-"));
  const path = join(root, "worker.sock");
  const brokerToken = "d".repeat(64);
  const oldKey = "fixture-original-secret";
  const newKey = "fixture-replacement-secret";
  const receipt = randomUUID().replaceAll("-", "").repeat(2);
  const calls: Array<[string, string | null]> = [];
  const send = (async (input, init) => {
    const url = new URL(String(input));
    calls.push([url.pathname, new Headers(init?.headers).get("authorization")]);
    if (url.pathname.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: encoded }] });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const system = new CreationMediaExecutors(root, {}, send);
  const worker = await serveMediaBroker(path, brokerToken, system);
  const actor = "owner-a";
  const outsider = "owner-b";
  const client = mediaBrokerClient(path, async () => brokerToken);
  const credentialId = randomUUID();
  try {
    const registration = { id: credentialId, target: "openai", name: "Studio", revision: 0, apiKey: oldKey };
    const saved = await client.saveCredential(actor, registration);
    expect(saved).toEqual({ id: credentialId, target: "openai", name: "Studio", revision: 1 });
    expect(await client.saveCredential(actor, registration)).toEqual(saved);
    expect((await client.list(outsider)).credentials).toEqual([]);
    await expect(client.removeCredential(outsider, credentialId, 1)).rejects.toMatchObject({ code: "notFound" });
    const newExecutor = {
      id: randomUUID(),
      preset: "openai-image",
      model: "gpt-image-2.6-flare",
      credentialId,
      revision: 0,
    };
    await expect(client.save(outsider, newExecutor)).rejects.toMatchObject({ code: "notFound" });
    await expect(
      client.save(actor, { ...newExecutor, preset: "grok-image", model: "grok-imagine-image-2.0" }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(client.save(actor, { ...newExecutor, baseUrl: "https://bad.invalid" })).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect(calls).toHaveLength(0);

    const first = await client.save(actor, newExecutor);
    const second = await client.save(actor, { ...newExecutor, id: randomUUID(), model: "gpt-image-2.6-sunburst" });
    const audio = await client.save(actor, {
      ...newExecutor,
      id: randomUUID(),
      preset: "openai-audio",
      model: "gpt-audio-1.5",
    });
    expect([first, second, audio].every((row) => row.credentialId === credentialId)).toBe(true);
    expect(calls.every(([, authorization]) => authorization === "Bearer " + oldKey)).toBe(true);
    const choice = { kind: "image", source: "executor", executorId: first.id } as const;
    const before = await client.bind(actor, choice);
    expect(before.credentialRevision).toBe(1);
    expect(mediaBinding(JSON.parse(JSON.stringify(before)))).toEqual(before);

    await client.saveCredential(actor, { ...saved, name: "Renamed Studio" });
    await client.assertBound(actor, before);
    expect(await client.submit(actor, before, receipt, "fixture", new AbortController().signal)).toEqual({
      state: "succeeded",
      bytes: image,
    });

    const rotation = { ...saved, name: "Renamed Studio", revision: 2, apiKey: newKey };
    const races = await Promise.allSettled([
      client.saveCredential(actor, rotation),
      client.saveCredential(actor, rotation),
    ]);
    expect(races.some((result) => result.status === "fulfilled")).toBe(true);
    await client.saveCredential(actor, rotation);
    const catalog = await client.list(actor);
    expect(
      catalog.executors.every(
        (row) => row.credentialId === credentialId && row.revision === 1 && row.status === "unverified",
      ),
    ).toBe(true);
    const dispatched = calls.length;
    await expect(client.submit(actor, before, receipt, "fixture", new AbortController().signal)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(calls).toHaveLength(dispatched);
    const after = await client.bind(actor, choice);
    expect(after.credentialRevision).toBe(2);
    await client.submit(actor, after, receipt, "fixture", new AbortController().signal);
    expect(calls.at(-1)).toEqual(["/v1/images/generations", "Bearer " + newKey]);
    expect((await client.list(actor)).executors.find((item) => item.id === first.id)?.status).toBe("connected");

    await client.removeCredential(actor, credentialId, 3);
    await client.removeCredential(actor, credentialId, 3);
    await expect(client.bind(actor, choice)).rejects.toMatchObject({ code: "notFound" });
    const revoked = await client.list(actor);
    expect(revoked.credentials).toEqual([]);
    expect(revoked.executors.every((row) => row.credentialUnavailable)).toBe(true);
    await expect(client.saveCredential(actor, registration)).rejects.toMatchObject({ code: "conflict" });
    const disk = (await readdir(root, { recursive: true })).filter((entry) => /\.(json|sqlite)$/.test(entry));
    for (const file of disk) {
      const contents = await readFile(join(root, file));
      expect(contents.includes(oldKey)).toBe(false);
      expect(contents.includes(newKey)).toBe(false);
    }
    expect(JSON.stringify(catalog)).not.toContain(oldKey);
    expect(JSON.stringify(catalog)).not.toContain(newKey);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
