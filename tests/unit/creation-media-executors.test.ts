import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreationMediaExecutors } from "../../src/server/creation/integration/media-executors/service.js";
import { CreationMediaJobs } from "../../src/server/creation/integration/media-executors/jobs.js";
import { creationMediaExecutorRoutes } from "../../src/server/creation/integration/media-executors/routes.js";
import { recordLocalIdentity } from "../../src/server/auth/users/identity.js";
import type { CreationMediaCliRegistration } from "../../src/shared/creation/media-executors.js";
import {
  mediaBrokerClient,
  readMediaBrokerToken,
  serveMediaBroker,
} from "../../src/server/creation/integration/media-executors/broker.js";
import { decodedImage } from "../../src/server/creation/integration/rendering/image-result.js";
import { harnessCreationCapabilities } from "../../src/server/harness/creation-capabilities.js";
import type { HarnessRuntimeView } from "../../src/shared/harness/contracts.js";

test("native image capability requires the reviewed protocol, actual model and renderer version", async () => {
  const runtime: HarnessRuntimeView = {
    id: "grok-test",
    name: "Grok Build",
    profileId: "grok-build",
    kind: "grok-build",
    enabled: true,
    status: "ready",
    protocol: "acp/1",
    revision: 1,
    access: "administrators",
    createdAt: 0,
    updatedAt: 0,
    defaultModel: null,
    defaultEffort: null,
    deployment: "local",
    isDefault: false,
    capabilities: {
      text: true,
      imageInput: true,
      fileInput: false,
      tools: true,
      permissions: true,
      load: true,
      models: true,
      imageGeneration: "unknown",
    },
    models: [{ id: "grok", name: "Grok", efforts: [] }],
  };
  let probes = 0;
  const reviewed = async () => {
    probes++;
    return "1.0.89";
  };
  expect(await harnessCreationCapabilities(runtime, reviewed, "grok")).toMatchObject({
    nativeImageStatus: "available",
    nativeImage: true,
    imageUnderstanding: true,
    imageEditing: false,
    nativeVideo: false,
  });
  for (const variant of [
    { ...runtime, protocol: undefined },
    { ...runtime, status: "authentication" as const },
    { ...runtime, models: [] },
  ])
    expect((await harnessCreationCapabilities(variant, reviewed)).nativeImageStatus).toBe("unverified");
  expect((await harnessCreationCapabilities(runtime, reviewed, "stale-model")).nativeImage).toBe(false);
  expect(probes).toBe(1);
  expect((await harnessCreationCapabilities(runtime, async () => "1.0.90")).nativeImage).toBe(false);
  expect((await harnessCreationCapabilities({ ...runtime, kind: "claude-code" }, reviewed)).nativeImageStatus).toBe(
    "unsupported",
  );
  expect(probes).toBe(1);
});

test("executor account and version are frozen, hidden and owner-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-media-scope-"));
  try {
    const calls: string[] = [],
      headers: Headers[] = [];
    const send = (async (input, init) => {
      calls.push(String(input));
      headers.push(new Headers(init?.headers));
      return Response.json({ id: "verified-model" });
    }) as typeof fetch;
    const service = new CreationMediaExecutors(root, {}, send);
    const id = randomUUID(),
      apiKey = "fixture-key";
    const inputs = { id, preset: "openai-image", apiKey, revision: 0 };
    const saved = await service.save("owner-a", inputs);
    expect(await service.save("owner-a", inputs)).toEqual(saved);
    expect(calls).toHaveLength(1);
    expect(headers[0]?.get("authorization")).toBe("Bearer " + apiKey);
    expect(JSON.stringify(await service.list("owner-a"))).not.toContain(apiKey);
    expect((await service.list("owner-b")).executors).toEqual([]);
    const choice = { kind: "image", source: "executor", executorId: id } as const;
    await expect(service.bind("owner-b", choice)).rejects.toMatchObject({ code: "notFound" });
    const binding = await service.bind("owner-a", choice);
    await expect(
      service.save("owner-a", { ...inputs, revision: 1, baseUrl: "https://unapproved.invalid" }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    expect(calls).toHaveLength(1);
    await service.save("owner-a", { ...inputs, revision: 1, apiKey: "replacement-key" });
    await expect(service.assertBound("owner-a", binding)).rejects.toMatchObject({ code: "conflict" });
    await service.remove("owner-a", id, 2);
    await expect(service.bind("owner-a", choice)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executor models are chosen from the provider's category and retained with the connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-executor-catalog-"));
  try {
    const requests: string[] = [];
    const send = (async (input) => {
      requests.push(String(input));
      return Response.json({ id: "verified-model" });
    }) as typeof fetch;
    const service = new CreationMediaExecutors(root, {}, send);
    const catalog = await service.list("owner");
    expect(catalog.presets.find((preset) => preset.id === "openai-image")).toMatchObject({
      kind: "image",
      provider: "openai",
    });
    expect(catalog.presets.find((preset) => preset.id === "openai-audio")).toMatchObject({
      kind: "audio",
      provider: "openai",
    });

    const id = randomUUID(),
      media = { id, revision: 0, preset: "openai-image", apiKey: "private-key" };
    await expect(service.save("owner", { ...media, model: "gpt-6.2-sol" })).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect(requests).toHaveLength(0);
    const model = "gpt-image-2.6-flare";
    const saved = await service.save("owner", { ...media, model });
    expect(await service.save("owner", { ...media, model })).toEqual(saved);
    expect(requests).toEqual(["https://api.openai.com/v1/models/" + model]);
    const restarted = new CreationMediaExecutors(root, {}, send);
    expect((await restarted.list("owner")).executors).toEqual([saved]);
    const selection = { kind: "image", source: "executor", executorId: id } as const;
    expect(await restarted.bind("owner", selection)).toMatchObject({ model });
    await expect(restarted.bind("owner", { ...selection, model: "gpt-image-2.5-sunburst" })).rejects.toMatchObject({
      code: "invalidInput",
    });
    expect(
      await restarted.save("owner", {
        id: randomUUID(),
        revision: 0,
        preset: "openai-text",
        model: "gpt-6.2-sol",
        apiKey: "private-key",
      }),
    ).toMatchObject({ kind: "text", model: "gpt-6.2-sol" });
    const mediaOwner = createHash("sha256").update("owner").digest("hex");
    const recordDirectory = join(root, "creation-media", "owners", mediaOwner, id);
    const recordFile = (await readdir(recordDirectory)).find((entry) => entry.endsWith(".json"))!;
    const legacy = JSON.parse(await readFile(join(recordDirectory, recordFile), "utf8"));
    expect(legacy).not.toHaveProperty("model");
    expect(legacy).toMatchObject({ id, kind: "image" });

    const shared = { ...media, id: randomUUID() };
    const results = await Promise.allSettled([
      restarted.save("owner", { ...shared, model }),
      restarted.save("owner", { ...shared, preset: "openai-text", model: "gpt-6.2-sol" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await restarted.list("owner")).executors.filter((item) => item.id === shared.id)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the restarted background worker resumes an authorized Seedance job before Harness retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-media-resume-"));
  try {
    const video = await readFile(new URL("../support/media/preview.mp4", import.meta.url));
    const cancel = new AbortController(),
      providerCalls: string[] = [];
    let connectionChecks = 0;
    const send = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tasks") && init?.method === "GET") {
        connectionChecks++;
        expect(url.searchParams.get("page_size")).toBe("1");
        return ["Bearer fixture-key", "Bearer rotated-fixture-key"].includes(
          new Headers(init.headers).get("authorization") ?? "",
        )
          ? Response.json({ items: [] })
          : new Response(null, { status: 401 });
      }
      if (url.host === "ark-acg-cn-beijing.tos-cn-beijing.volces.com") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(video);
      }
      providerCalls.push(String(init?.method));
      if (init?.method === "POST") return Response.json({ id: "cgt-fixture" });
      if (!cancel.signal.aborted) {
        cancel.abort();
        return Response.json({ id: "cgt-fixture", status: "running" });
      }
      return Response.json({
        id: "cgt-fixture",
        status: "succeeded",
        content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result" },
      });
    }) as typeof fetch;
    const service = new CreationMediaExecutors(root, {}, send);
    const id = randomUUID();
    await expect(
      service.save("owner-a", { id, preset: "seedance-video", apiKey: "invalid-key", revision: 0 }),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(
      (await service.save("owner-a", { id, preset: "seedance-video", apiKey: "fixture-key", revision: 0 })).status,
    ).toBe("unverified");
    expect(connectionChecks).toBe(2);
    expect(providerCalls).toEqual([]);
    const binding = await service.bind("owner-a", { kind: "video", source: "executor", executorId: id });
    const job = {
      owner: "owner-a",
      creationId: randomUUID(),
      projectId: "project-a",
      inputDigest: "a".repeat(64),
      binding,
    };
    const ledger = join(root, "ledger"),
      authorize = async () => {};
    let jobId: string | undefined;
    await expect(
      new CreationMediaJobs(ledger, service, 1).run(job, "slot", "Prompt", cancel.signal, authorize, (id) => {
        jobId = id;
      }),
    ).rejects.toBeDefined();
    if (!jobId) throw Error("Missing durable media job ID");
    const resumed = new CreationMediaJobs(ledger, service, 1);
    expect(await resumed.existingId(job, "slot", "Prompt")).toBe(jobId);
    expect(await resumed.status(job, jobId)).toBe("generating");
    await expect(resumed.status({ ...job, owner: "owner-b" }, jobId)).rejects.toMatchObject({
      code: "notFound",
    });
    await expect(resumed.status({ ...job, creationId: randomUUID() }, jobId)).rejects.toMatchObject({
      code: "notFound",
    });
    await expect(resumed.status(job, "0".repeat(64))).rejects.toMatchObject({ code: "notFound" });
    await expect(resumed.run(job, "slot", "Other prompt", AbortSignal.timeout(500), authorize)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      resumed.run({ ...job, creationId: randomUUID() }, "slot", "Prompt", AbortSignal.timeout(500), authorize),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const checked = Promise.withResolvers<void>(),
      diagnostics: unknown[] = [];
    let canRecover = false;
    resumed.start(
      async (scope) => {
        expect(scope).toEqual(job);
        checked.resolve();
        return canRecover;
      },
      (error) => diagnostics.push(error),
    );
    try {
      await Promise.race([
        checked.promise,
        Bun.sleep(1000).then(() => {
          throw new Error("Worker did not read its queue");
        }),
      ]);
      expect(providerCalls).toEqual(["POST", "GET"]);
      canRecover = true;
      const deadline = Date.now() + 1500;
      while ((await resumed.status(job, jobId)) !== "ready" && Date.now() < deadline) await Bun.sleep(10);
      expect(await resumed.status(job, jobId)).toBe("ready");
      const result = await resumed.run(job, "slot", "Prompt", AbortSignal.timeout(2000), authorize);
      expect(result.bytes.equals(video)).toBe(true);
      expect(result.invocationId).toBe("cgt-fixture");
      expect(providerCalls).toEqual(["POST", "GET", "GET"]);
      expect(diagnostics).toEqual([]);
      const restarted = new CreationMediaExecutors(root, {}, send);
      expect((await restarted.list("owner-a")).executors[0]).toMatchObject({ revision: 1, status: "connected" });
      expect((await restarted.list("owner-b")).executors).toEqual([]);
      await restarted.save("owner-a", { id, preset: "seedance-video", apiKey: "rotated-fixture-key", revision: 1 });
      expect((await restarted.list("owner-a")).executors[0]).toMatchObject({ revision: 2, status: "unverified" });
      await expect(restarted.assertBound("owner-a", binding)).rejects.toMatchObject({ code: "conflict" });
      expect(await resumed.status(job, jobId)).toBe("ready");
      await restarted.remove("owner-a", id, 2);
      const recovered = await new CreationMediaJobs(ledger, restarted, 1).run(
        job,
        "slot",
        "Prompt",
        AbortSignal.timeout(2000),
        authorize,
      );
      expect(recovered.bytes.equals(video)).toBe(true);
      expect(recovered.invocationId).toBe("cgt-fixture");
      expect(providerCalls).toEqual(["POST", "GET", "GET"]);
    } finally {
      await resumed.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["rotated", "revoked", "endpoint removed"])(
  "a known provider job stops locally when its connection is %s",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "panda-media-job-disconnected-"));
    const originalWait = new AbortController(),
      providerCalls: string[] = [],
      diagnostics: unknown[] = [];
    const send = (async (input, init) => {
      if (String(input).includes("?page_size=1")) return Response.json({ items: [] });
      providerCalls.push(String(init?.method));
      if (init?.method === "POST") return Response.json({ id: "cgt-fixture" });
      originalWait.abort();
      return Response.json({ id: "cgt-fixture", status: "running" });
    }) as typeof fetch;
    const owner = "owner-a",
      id = randomUUID(),
      state = join(root, "private"),
      ledger = join(root, "jobs"),
      endpoint = "https://ark-qa.example.test/api/v3",
      env = { PANDA_FORCE_MEDIA_EXECUTOR_ENDPOINTS: JSON.stringify({ "seedance-video": [endpoint] }) },
      service = new CreationMediaExecutors(state, env, send),
      socket = join(root, "worker.sock"),
      token = "a".repeat(64),
      client = mediaBrokerClient(socket, async () => token),
      authorize = async () => {};
    let broker = await serveMediaBroker(socket, token, service);
    try {
      const input = { id, preset: "seedance-video", apiKey: "fixture-key", baseUrl: endpoint, revision: 0 };
      await client.save(owner, input);
      const binding = await client.bind(owner, { kind: "video", source: "executor", executorId: id });
      const scope = { owner, binding, projectId: "project-a", creationId: randomUUID(), inputDigest: "a".repeat(64) };
      const initial = new CreationMediaJobs(ledger, client, 1);
      let jobId = "";
      await expect(
        initial.run(scope, "slot", "A drawing", originalWait.signal, authorize, (job) => {
          jobId = job;
        }),
      ).rejects.toBeDefined();
      expect(await initial.status(scope, jobId)).toBe("generating");
      expect(providerCalls).toEqual(["POST", "GET"]);

      if (change === "revoked") await client.remove(owner, id, 1);
      if (change === "rotated") await client.save(owner, { ...input, revision: 1, apiKey: "rotated-fixture-key" });
      await broker.close();
      const restarted = new CreationMediaExecutors(state, change === "endpoint removed" ? {} : env, send);
      broker = await serveMediaBroker(socket, token, restarted);
      const recovered = new CreationMediaJobs(ledger, client, 1);
      recovered.start(
        () => true,
        (error) => diagnostics.push(error),
      );
      try {
        const deadline = Date.now() + 2000;
        while ((await recovered.status(scope, jobId)) !== "stoppedLocally" && Date.now() < deadline)
          await Bun.sleep(10);
        expect(await recovered.status(scope, jobId)).toBe("stoppedLocally");
        await expect(
          recovered.run(scope, "slot", "A drawing", AbortSignal.timeout(1000), authorize),
        ).rejects.toMatchObject({ code: "stoppedLocally" });
        expect(providerCalls).toEqual(["POST", "GET"]);
        expect(diagnostics).toEqual([]);
      } finally {
        await recovered.close();
      }
      const journal = join(ledger, "jobs");
      const receipts = await Promise.all(
        (await readdir(journal)).map(
          async (name) => JSON.parse(await readFile(join(journal, name), "utf8")) as unknown,
        ),
      );
      expect(receipts).toContainEqual(expect.objectContaining({ stage: "pending", taskId: "cgt-fixture" }));
      expect(await readdir(join(ledger, "pending"))).toEqual([]);
    } finally {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an executor reports a safe error without sharing a provider failure body or following redirects", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-media-rejected-"));
  try {
    const send = (async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return new Response("response echoing fixture-secret and https://fixture.internal", { status: 403 });
    }) as typeof fetch;
    const service = new CreationMediaExecutors(root, {}, send);
    await expect(
      service.save("owner-a", { id: randomUUID(), preset: "openai-image", apiKey: "fixture-secret", revision: 0 }),
    ).rejects.toMatchObject({ message: "authentication", code: "authentication" });
    expect((await service.list("owner-a")).executors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["uncertain", "awaitingConfirmation"],
  ["invalidResult", "failed"],
] as const)("job status after %s does not dispatch again", async (failure, state) => {
  const root = await mkdtemp(join(tmpdir(), "panda-media-job-status-"));
  try {
    const submitted = Promise.withResolvers<void>(),
      reply = Promise.withResolvers<void>();
    let calls = 0;
    const send = (async (_input, init) => {
      if (init?.method !== "POST") return Response.json({ id: "verified-model" });
      calls++;
      submitted.resolve();
      await reply.promise;
      if (failure === "uncertain") throw Error("Connection ended before the receipt");
      return Response.json({ data: [{ b64_json: Buffer.from("invalid image").toString("base64") }] });
    }) as typeof fetch;
    const media = new CreationMediaExecutors(join(root, "private"), {}, send);
    const id = randomUUID(),
      owner = "owner-a";
    await media.save(owner, { id, preset: "openai-image", apiKey: "fixture-key", revision: 0 });
    const binding = await media.bind(owner, { kind: "image", source: "executor", executorId: id });
    const scope = { owner, binding, projectId: "project-a", creationId: randomUUID(), inputDigest: "a".repeat(64) };
    const ledger = join(root, "jobs"),
      jobs = new CreationMediaJobs(ledger, media, 1),
      authorize = async () => {};
    let jobId: string | undefined;
    const work = jobs.run(scope, "slot", "A drawing", AbortSignal.timeout(2000), authorize, (id) => {
      jobId = id;
    });
    try {
      await submitted.promise;
      if (!jobId) throw Error("Missing media job ID");
      expect(await jobs.status(scope, jobId)).toBe("generating");
    } finally {
      reply.resolve();
    }
    await expect(work).rejects.toMatchObject({ code: failure });
    const restarted = new CreationMediaJobs(ledger, media, 1);
    expect(await restarted.status(scope, jobId)).toBe(state);
    await expect(restarted.run(scope, "slot", "A drawing", AbortSignal.timeout(1000), authorize)).rejects.toBeDefined();
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the private worker requires the application token and returns media without exporting credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-media-broker-"));
  try {
    const token = "a".repeat(64),
      tokenPath = join(root, "application-token"),
      socket = join(root, "worker.sock"),
      bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEElEQVR4nGP4z8AARAzYKAB3pAf53le34gAAAABJRU5ErkJggg==",
        "base64",
      );
    await writeFile(tokenPath, token, { mode: 0o640 });
    let providerCalls = 0;
    const send = (async (_input, init) => {
      providerCalls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer vendor-secret");
      return init?.method === "POST"
        ? Response.json(
            { data: [{ b64_json: bytes.toString("base64") }] },
            { headers: { "x-request-id": "owned-result" } },
          )
        : Response.json({ id: "verified-model" });
    }) as typeof fetch;
    const broker = await serveMediaBroker(socket, token, new CreationMediaExecutors(join(root, "private"), {}, send));
    try {
      const client = mediaBrokerClient(socket, () => readMediaBrokerToken(tokenPath)),
        outsider = mediaBrokerClient(socket, async () => "b".repeat(64));
      const executorId = randomUUID();
      const credentials = { id: executorId, preset: "openai-image", apiKey: "vendor-secret", revision: 0 };
      await expect(outsider.save("owner-a", credentials)).rejects.toMatchObject({ code: "authentication" });
      expect(providerCalls).toBe(0);
      expect(JSON.stringify(await client.save("owner-a", credentials))).not.toContain("vendor-secret");
      expect(JSON.stringify(await client.list("owner-a"))).not.toContain("vendor-secret");
      const selection = { kind: "image", source: "executor", executorId } as const;
      await expect(client.bind("owner-b", selection)).rejects.toMatchObject({ code: "notFound" });
      const binding = await client.bind("owner-a", selection);
      await expect(
        client.submit("owner-a", binding, "c".repeat(64), "An image", AbortSignal.timeout(5000)),
      ).resolves.toEqual({ state: "succeeded", bytes, invocationId: "owned-result" });
      expect(providerCalls).toBe(2);
      await chmod(tokenPath, 0o644);
      await expect(client.list("owner-a")).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await broker.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed reference CLI registers, verifies its account and delivers media through submit, status, result and download", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-media-cli-check-"));
  try {
    const installed = join(root, "bin", "fixture"),
      manifest = join(root, "executor.json");
    await mkdir(join(root, "bin"));
    await copyFile(new URL("../support/creation-media-cli-fixture.ts", import.meta.url), installed);
    await chmod(installed, 0o755);
    const sha256 = createHash("sha256")
      .update(await readFile(installed))
      .digest("hex");
    const configuration = {
      schema: "panda.media-cli/v1",
      id: "fixture",
      revision: 1,
      version: "1.0.0",
      name: "Reference CLI",
      model: "fixture",
      mode: "async",
      capabilities: ["image.generate"],
      connection: { baseUrl: { mode: "provided", default: "https://provider.invalid" }, auth: "api-key" },
      entrypoint: "bin/fixture",
      usage: "USAGE.md",
      install: {
        mode: "preinstalled",
        guide: "INSTALL.md",
        artifacts: [
          {
            os: process.platform,
            arch: process.arch === "x64" ? "amd64" : process.arch,
            file: "bin/fixture",
            sha256,
          },
        ],
      },
      operations: Object.fromEntries(
        ["version", "check", "submit", "status", "result", "download", "cancel"].map((name) => [name, [name]]),
      ),
    };
    const environment = { PANDA_FORCE_MEDIA_CLI_MANIFESTS: JSON.stringify([manifest]) };
    await writeFile(manifest, JSON.stringify(configuration));
    expect(() => new CreationMediaExecutors(root, environment)).toThrow("invalidInput");
    await writeFile(join(root, "USAGE.md"), "Submit, query, get the result, and download.");
    await writeFile(join(root, "INSTALL.md"), "Install the reviewed executable and verify its SHA-256.");
    await writeFile(manifest, JSON.stringify({ ...configuration, version: "1.0.1" }));
    const incompatible = new CreationMediaExecutors(root, environment);
    expect((await incompatible.list("owner-a")).presets.map((preset) => preset.id)).not.toContain("cli-fixture");
    await expect(
      incompatible.save("owner-a", {
        id: randomUUID(),
        preset: "cli-fixture",
        apiKey: "fixture-secret",
        revision: 0,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(manifest, JSON.stringify(configuration));
    const service = new CreationMediaExecutors(root, environment);
    expect((await service.list("owner-a")).presets.map((preset) => preset.id)).toContain("cli-fixture");
    const id = randomUUID();
    await expect(
      service.save("owner-a", { id, preset: "cli-fixture", apiKey: "invalid", revision: 0 }),
    ).rejects.toMatchObject({ code: "authentication" });
    const saved = await service.save("owner-a", { id, preset: "cli-fixture", apiKey: "fixture-secret", revision: 0 });
    expect(saved.status).toBe("connected");
    const binding = await service.bind("owner-a", { kind: "image", source: "executor", executorId: id });
    const result = await new CreationMediaJobs(join(root, "ledger"), service, 1).run(
      { owner: "owner-a", binding, creationId: randomUUID(), projectId: "project-a", inputDigest: "a".repeat(64) },
      "slot",
      "A drawing",
      AbortSignal.timeout(20000),
      async () => {},
    );
    expect(result.invocationId).toBe("fixture-task");
    expect(await decodedImage(result.bytes)).toMatchObject({ width: 2, height: 4, mime: "image/png" });
    const socket = join(root, "worker.sock"),
      token = "a".repeat(64),
      broker = await serveMediaBroker(socket, token, service);
    try {
      const client = mediaBrokerClient(socket, async () => token);
      await expect(
        client.cancel("owner-b", binding, "queued-fixture-task", AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({
        code: "notFound",
      });
      for (const [taskId, state] of [
        ["queued-fixture-task", "cancelled"],
        ["fixture-task", "stoppedLocally"],
      ]) {
        await expect(client.cancel("owner-a", binding, taskId!, AbortSignal.timeout(5000))).resolves.toEqual({ state });
      }
      expect((await service.poll("owner-a", binding, "fixture-task", AbortSignal.timeout(5000))).state).toBe(
        "succeeded",
      );
    } finally {
      await broker.close();
    }
    const registrationState = join(root, "registration"),
      registrationEnv = {
        PANDA_FORCE_MEDIA_CLI_REGISTRATION_MANIFESTS: JSON.stringify([manifest]),
      };
    const registration = new CreationMediaExecutors(registrationState, registrationEnv);
    const gated = await serveMediaBroker(socket, token, registration);
    const apiPath = "/api/personal/creation-media-cli";
    const route = creationMediaExecutorRoutes(
      mediaBrokerClient(socket, async () => token),
      () => "owner-a",
    ).find(({ path }) => path === apiPath)!;
    const http = createServer((req, res) => {
      const role = req.headers["x-fixture-role"];
      if (role === "admin" || role === "member")
        recordLocalIdentity(req, { id: role, revision: 1, owner: role, username: role, role });
      void route.handler({ req, res, url: new URL(req.url!, "http://local") });
    });
    http.listen(0, "127.0.0.1");
    try {
      await once(http, "listening");
      const address = http.address();
      if (!address || typeof address === "string") throw Error("Missing test HTTP address");
      const api = (role: string, query = "", input?: object) =>
        fetch("http://127.0.0.1:" + address.port + apiPath + query, {
          headers: { "x-fixture-role": role, "content-type": "application/json" },
          ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
        });
      expect((await api("member")).status).toBe(403);
      expect((await api("unknown")).status).toBe(403);
      const { packages } = (await (await api("admin")).json()) as { packages: CreationMediaCliRegistration[] };
      const [item] = packages;
      expect(item).toMatchObject({ id: "cli-fixture", registered: false, sha256, version: "1.0.0" });
      const input = { id: item!.id, revision: item!.revision, fingerprint: item!.fingerprint };
      const query = "?id=cli-fixture&revision=1";
      expect((await api("member", query)).status).toBe(403);
      expect(await (await api("admin", query)).json()).toEqual({
        install: "Install the reviewed executable and verify its SHA-256.",
        usage: "Submit, query, get the result, and download.",
      });
      expect((await api("member", "", input)).status).toBe(403);
      expect((await api("admin", "", { ...input, path: manifest })).status).toBe(400);
      expect((await api("admin", "", { ...input, fingerprint: "0".repeat(64) })).status).toBe(409);
      const account = { id: randomUUID(), preset: input.id, apiKey: "fixture-secret", revision: 0 };
      await expect(registration.save("owner-a", account)).rejects.toMatchObject({ code: "notFound" });
      await chmod(installed, 0o644);
      expect((await api("admin", "", input)).status).toBe(503);
      expect((await registration.list("owner-a")).presets.map((entry) => entry.id)).not.toContain(input.id);
      await chmod(installed, 0o755);
      const replies = await Promise.all([api("admin", "", input), api("admin", "", input)]);
      expect(replies.map(({ status }) => status)).toEqual([200, 200]);
      const restarted = new CreationMediaExecutors(registrationState, registrationEnv);
      expect((await restarted.cliCatalog())[0]!.registered).toBe(true);
      expect(await restarted.save("owner-a", account)).toMatchObject({ status: "connected" });
      await writeFile(join(root, "USAGE.md"), "Changed documentation for the same revision.");
      const changed = new CreationMediaExecutors(registrationState, registrationEnv);
      const [replacement] = await changed.cliCatalog();
      expect(replacement).toMatchObject({ id: input.id, registered: false });
      await expect(
        changed.registerCli(input.id, input.revision, replacement!.fingerprint, AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      await gated.close();
    }
    await writeFile(installed, "tampered");
    expect(() => new CreationMediaExecutors(root, environment)).toThrow("unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
