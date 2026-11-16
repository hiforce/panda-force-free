import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { executorConfig, imageReference } from "../../src/executor/config.js";
import { registryAuthorization } from "../../src/executor/docker/registry.js";
import { DockerApi } from "../../src/executor/docker/api.js";
import { DockerBuildDriver } from "../../src/executor/docker/driver.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import { DockerStreams } from "../../src/executor/docker/stream.js";
import { ExecutionStore } from "../../src/executor/store.js";
import { ExecutionService } from "../../src/executor/service.js";
import { executionHandler } from "../../src/executor/http.js";
import { buildInput, BuildError } from "../../src/shared/builds/validation.js";
import type { BuildInput, BuildArtifact } from "../../src/shared/builds/contracts.js";
import { utf8Prefix } from "../../src/shared/utf8.js";
import type { Duplex } from "node:stream";

const input: BuildInput = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "A handbook", url: "https://docs.example.test", basePath: "/docs/", locale: "en" },
  documents: [{ id: "a", path: "intro.md", title: "Welcome", content: "Hello" }],
  assets: [],
};
const bytes = Buffer.from("<h1>Welcome</h1>");
const artifact: BuildArtifact = {
  protocol: 1,
  bytes: bytes.length,
  files: [
    { path: "index.html", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") },
  ],
};
test("Docker worker deadlines and user cancellation are distinct and both clean up owned containers", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-driver-deadline-")),
    socket = join(root, "docker.sock");
  const streams = new Set<Duplex>();
  let removed = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url?.includes("/images/"))
      res.end(
        JSON.stringify({
          Id: `sha256:${"a".repeat(64)}`,
          Config: { Labels: { "ai.hiforce.panda.build-protocol": "1", "ai.hiforce.panda.engine.hexo": "8.1.1" } },
        }),
      );
    else if (req.method === "DELETE") {
      removed++;
      res.statusCode = 204;
      res.end();
    } else if (req.method === "GET")
      res.end(JSON.stringify({ Config: { Labels: { "ai.hiforce.panda.executor": "fixture" } } }));
    else res.end("{}");
  });
  server.on("upgrade", (_req, stream) => {
    streams.add(stream);
    stream.on("error", () => {});
    stream.on("close", () => streams.delete(stream));
    stream.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    stream.resume();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const config = {
      ...executorConfig({ PANDA_FORCE_ENGINE_PULL_POLICY: "never" }),
      dockerSocket: socket,
      timeoutMs: 30,
    };
    const driver = new DockerBuildDriver(config, "fixture");
    await expect(
      driver.run(
        randomUUID(),
        input,
        new AbortController().signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("buildTimeout");
    expect(removed).toBe(1);
    const cancel = new AbortController();
    await expect(
      driver.run(
        randomUUID(),
        input,
        cancel.signal,
        (change) => {
          if (change.phase === "running") cancel.abort();
        },
        () => {},
      ),
    ).rejects.toThrow("cancelled");
    expect(removed).toBe(2);
  } finally {
    for (const stream of streams) stream.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
test("administrators can replace each engine with a Harbor tag or digest and disable registry access", () => {
  const config = executorConfig({
    PANDA_FORCE_HEXO_IMAGE: "harbor.example.test:8443/team/hexo:custom",
    PANDA_FORCE_DOCUSAURUS_IMAGE: `harbor.example.test/team/docs@sha256:${"a".repeat(64)}`,
    PANDA_FORCE_ENGINE_PULL_POLICY: "never",
  });
  expect(config.images.hexo).toEqual({ reference: "harbor.example.test:8443/team/hexo:custom", pullPolicy: "never" });
  expect(config.images.docusaurus.pullPolicy).toBe("never");
  for (const bad of [
    "https://registry.example/image:1",
    "name:1 --privileged",
    "user:password@registry/image:1",
    "image\n:1",
    "../image:1",
    "registry/image",
  ])
    expect(() => imageReference(bad)).toThrow();
  expect(() => executorConfig({ PANDA_FORCE_ENGINE_PULL_POLICY: "sometimes" })).toThrow();
});
test("document input cannot select images, container options or arbitrary paths", () => {
  expect(buildInput(input)).toEqual(input);
  expect(() => buildInput({ ...input, image: "attacker/tool:latest" })).toThrow("unsupportedOption");
  for (const path of ["../token.md", "/etc/passwd.md", "x/../token.md", "x\\y.md", "code.mdx", ".env.md"])
    expect(() => buildInput({ ...input, documents: [{ ...input.documents[0], path }] })).toThrow();
  expect(() => buildInput({ ...input, site: { ...input.site, url: "https://user:secret@example.test" } })).toThrow();
});
test("registry auth is scoped to the chosen registry and is never added to the image configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-registry-")),
    file = join(root, "config.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        auths: { "harbor.example.test": { auth: Buffer.from("robot:fake-pass:word").toString("base64") } },
      }),
    );
    const header = await registryAuthorization("harbor.example.test/team/engine:1", file);
    expect(JSON.parse(Buffer.from(header!, "base64").toString())).toEqual({
      serveraddress: "harbor.example.test",
      username: "robot",
      password: "fake-pass:word",
    });
    expect(await registryAuthorization("other.example.test/team/engine:1", file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ credsStore: "desktop", auths: {} }));
    await expect(registryAuthorization("harbor.example.test/team/engine:1", file)).rejects.toThrow(
      "registryCredentialHelperUnsupported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("pull policies, immutable identity and worker compatibility are enforced against the Docker protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-docker-api-")),
    socket = join(root, "docker.sock"),
    config = join(root, "auth.json");
  writeFileSync(
    config,
    JSON.stringify({
      auths: { "harbor.example.test": { auth: Buffer.from("robot:fixture-only").toString("base64") } },
    }),
  );
  let present = false,
    pulls = 0,
    protocol = "1",
    receivedAuth = false;
  const server = createServer((req, res) => {
    if (req.url?.includes("/images/create?")) {
      pulls++;
      receivedAuth = Boolean(req.headers["x-registry-auth"]);
      present = true;
      res.end('{"status":"done"}\n');
    } else if (!present) {
      res.statusCode = 404;
      res.end("{}");
    } else
      res.end(
        JSON.stringify({
          Id: `sha256:${"a".repeat(64)}`,
          RepoDigests: [
            `other.example.test/team/engine@sha256:${"c".repeat(64)}`,
            `harbor.example.test/team/engine@sha256:${"b".repeat(64)}`,
          ],
          Config: { Labels: { "ai.hiforce.panda.build-protocol": protocol, "ai.hiforce.panda.engine.hexo": "8.1.1" } },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const api = new DockerApi(socket),
      reference = "harbor.example.test/team/engine:1";
    await expect(
      resolveWorkerImage(api, { reference, pullPolicy: "never" }, "hexo", { credentials: config }),
    ).rejects.toThrow("imageNotAvailableLocally");
    expect(pulls).toBe(0);
    const resolved = await resolveWorkerImage(api, { reference, pullPolicy: "if-not-present" }, "hexo", {
      credentials: config,
    });
    expect(resolved.id).toBe(`sha256:${"a".repeat(64)}`);
    expect(resolved.digest).toBe(`harbor.example.test/team/engine@sha256:${"b".repeat(64)}`);
    expect(pulls).toBe(1);
    expect(receivedAuth).toBe(true);
    await resolveWorkerImage(api, { reference, pullPolicy: "if-not-present" }, "hexo", { credentials: config });
    expect(pulls).toBe(1);
    await resolveWorkerImage(api, { reference, pullPolicy: "always" }, "hexo", { credentials: config });
    expect(pulls).toBe(2);
    expect(
      (await resolveWorkerImage(api, { reference: `unknown.example.test/team/engine:1`, pullPolicy: "never" }, "hexo"))
        .digest,
    ).toBeNull();
    protocol = "2";
    await expect(resolveWorkerImage(api, { reference, pullPolicy: "never" }, "hexo")).rejects.toThrow(
      "incompatibleWorkerImage",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor storage bounds retained data, clears failed inputs and preserves terminal request identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-executor-quota-"));
  const store = new ExecutionStore(root, { maxBytes: 300 * 1024, maxJobs: 2, retentionMs: 7 * 86400000 });
  let runs = 0;
  const large = Buffer.alloc(180 * 1024, "x");
  const service = new ExecutionService(
    store,
    {
      async run() {
        runs++;
        return {
          protocol: 1 as const,
          bytes: large.length,
          files: [
            {
              path: "index.html",
              data: large.toString("base64"),
              sha256: createHash("sha256").update(large).digest("hex"),
            },
          ],
        };
      },
      async cleanup() {},
    },
    () => {},
  );
  try {
    const id = randomUUID();
    await service.start(id, input);
    for (let n = 0; n < 20 && store.get(id).phase !== "failed"; n++) await Bun.sleep(5);
    expect(store.get(id)).toMatchObject({ phase: "failed", error: "executorStorageFull" });
    expect(existsSync(join(root, "jobs", id, "input.json"))).toBe(false);
    expect(existsSync(join(root, "jobs", id, "result.json"))).toBe(false);
    await service.start(id, input);
    expect(runs).toBe(1);
    const active = randomUUID();
    store.create(active, input);
    expect(() => store.create(randomUUID(), input)).toThrow("executorStorageFull");
    store.prune(Date.now() + 8 * 86400000);
    expect(store.ids()).toEqual([active]);
    expect(store.input(active)).toEqual(input);
    store.create(randomUUID(), input);
    expect(store.ids()).toHaveLength(2);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Unicode and malformed worker log chunks remain valid and within the byte limit", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-executor-unicode-")),
    store = new ExecutionStore(root),
    id = randomUUID();
  try {
    store.create(id, input);
    store.logs(id, "a".repeat(128 * 1024 - 1) + "你好");
    const text = store.readLogs(id);
    expect(Buffer.byteLength(text)).toBe(128 * 1024 - 1);
    expect(text).not.toContain("�");
    expect(readFileSync(join(root, "jobs", id, "output.log"), "utf8")).toBe(text);
    expect(utf8Prefix(Buffer.from([0xff, 0xff, 0xe4]), 4)).toBe("�");
    expect(utf8Prefix("😀😀", 5)).toBe("😀");
    expect(utf8Prefix("你", 2)).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("worker streams preserve split frames and separate logs from bounded artifact output", () => {
  const frame = (channel: number, content: string) => {
    const bytes = Buffer.from(content),
      header = Buffer.alloc(8);
    header[0] = channel;
    header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
  };
  const streams = new DockerStreams(20, 8),
    data = Buffer.concat([frame(2, "build log too long"), frame(1, "result")]);
  for (const byte of data) streams.push(Buffer.from([byte]));
  const result = streams.finish();
  expect(result.stdout.toString()).toBe("result");
  expect(result.stderr.toString()).toBe("build lo");
  expect(() => new DockerStreams(2, 8).push(frame(1, "too big"))).toThrow("workerOutputTooLarge");
  const broken = new DockerStreams(20, 8);
  broken.push(data.subarray(0, 4));
  expect(() => broken.finish()).toThrow("incompleteWorkerStream");
});
test("retries remain idempotent, completion survives a restart and only executor-owned interrupted jobs are recovered", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-executor-"));
  let runs = 0;
  const cleaned: string[] = [];
  const driver = {
    async run() {
      runs++;
      return artifact;
    },
    async cleanup(id: string) {
      cleaned.push(id);
    },
  };
  try {
    const store = new ExecutionStore(root),
      service = new ExecutionService(store, driver, () => {}),
      id = randomUUID();
    await service.start(id, input);
    await service.start(id, input);
    for (let i = 0; i < 20 && (await service.status(id)).phase !== "completed"; i++) await Bun.sleep(10);
    expect(runs).toBe(1);
    expect(await service.result(id)).toEqual(artifact);
    await expect(
      service.start(id, { ...input, documents: [{ ...input.documents[0], content: "Changed" }] }),
    ).rejects.toThrow("idempotencyConflict");
    const interrupted = randomUUID();
    store.create(interrupted, input);
    store.update(interrupted, { phase: "running" });
    const reopened = new ExecutionService(new ExecutionStore(root), driver, () => {});
    await reopened.recover();
    expect(await reopened.result(id)).toEqual(artifact);
    expect((await reopened.status(interrupted)).error).toBe("executorRestarted");
    expect(cleaned.sort()).toEqual([id, interrupted].sort());
    expect(runs).toBe(1);
    store.prune(Date.now() + 8 * 86400000);
    expect(store.ids()).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("executor transport requires a service token and returns safe errors without request credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-executor-http-")),
    token = "a".repeat(64);
  try {
    const service = new ExecutionService(
      new ExecutionStore(root),
      {
        async run() {
          throw new BuildError("imageNotAvailableLocally", 503);
        },
        async cleanup() {},
      },
      () => {},
    );
    const handler = executionHandler(service, token),
      url = `http://executor/v1/builds/${randomUUID()}`;
    const capabilities = await handler(
      new Request("http://executor/v1/capabilities", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect((await capabilities.json()).features).toContain("profile-theme-packages/v1");
    expect((await handler(new Request(url))).status).toBe(401);
    const response = await handler(
      new Request(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(202);
    await Bun.sleep(10);
    const status = await handler(new Request(url, { headers: { Authorization: `Bearer ${token}` } }));
    expect(await status.json()).toMatchObject({ phase: "failed", error: "imageNotAvailableLocally" });
    service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-megabyte image input remains valid without regexp backtracking limits", () => {
  const data = Buffer.alloc(8 * 1024 * 1024).toString("base64");
  expect(buildInput({ ...input, assets: [{ path: "large.png", data, sha256: "a".repeat(64) }] }).assets[0].data).toBe(
    data,
  );
  for (const malformed of ["A===", "AAAA=AAA", "A", "AA!!", "AAA=="]) {
    expect(() =>
      buildInput({ ...input, assets: [{ path: "asset.png", data: malformed, sha256: "a".repeat(64) }] }),
    ).toThrow();
  }
});
