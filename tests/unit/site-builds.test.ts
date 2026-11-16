import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { BuildInput, BuildArtifact, BuildExecution } from "../../src/shared/builds/contracts.js";
import { SiteBuildRepository, hashBuildInput } from "../../src/server/builds/repository.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SiteBuildService } from "../../src/server/builds/service.js";
import { SiteBuildReconciler } from "../../src/server/builds/reconciler.js";
import { SiteBuildPreview, previewPolicy } from "../../src/server/builds/preview.js";
import { HttpSiteExecutor } from "../../src/server/builds/adapters/http-executor.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import { SiteBuildRetention } from "../../src/server/builds/retention.js";
import { buildImageReferences } from "../../src/server/builds/integration/references.js";
import { siteBuildRequest } from "../../src/server/builds/validation.js";

const spaceId = randomUUID(),
  documentId = randomUUID(),
  revisionId = randomUUID();
const request = () => ({
  id: randomUUID(),
  spaceId,
  engine: "hexo" as const,
  title: "Fixture site",
  locale: "en",
  url: "https://example.com",
  basePath: "/docs/",
});
const input: BuildInput = {
  protocol: 1,
  engine: "hexo",
  preset: "reader",
  site: { title: "Fixture site", locale: "en", url: "https://example.com", basePath: "/docs/" },
  documents: [{ id: documentId, path: "hello.md", title: "Hello", content: "Saved source" }],
  assets: [],
};
const sources = [{ id: documentId, path: "hello.md", revisionId, contentHash: "a".repeat(64) }];
const artifact = (files: Record<string, string>): BuildArtifact => ({
  protocol: 1,
  files: Object.entries(files).map(([path, text]) => ({
    path,
    data: Buffer.from(text).toString("base64"),
    sha256: createHash("sha256").update(text).digest("hex"),
  })),
  bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-build-test-")),
    db = new Database(":memory:");
  const jobs = new SiteBuildRepository(db),
    artifacts = new SiteBuildArtifacts(root);
  const remote = new Map<string, BuildExecution>(),
    calls: string[] = [];
  let loseAck = false,
    denied = false;
  const result = artifact({ "index.html": "<h1>Saved output</h1>" });
  const executor = {
    availability: async () => ({
      state: "ready" as const,
      themes: true,
      engines: { hexo: "8.1.1", docusaurus: "3.10.2" },
    }),
    async start(id: string, value: BuildInput) {
      calls.push(id);
      if (!remote.has(id))
        remote.set(id, {
          id,
          inputHash: hashBuildInput(value),
          engine: value.engine,
          phase: "running",
          createdAt: 1,
          updatedAt: 1,
        });
      if (loseAck) {
        loseAck = false;
        throw new SiteBuildError("executorUnavailable", 503);
      }
      return remote.get(id)!;
    },
    async status(id: string) {
      if (!remote.has(id)) throw new SiteBuildError("executorMissing", 404);
      return remote.get(id)!;
    },
    async cancel(id: string) {
      const row = remote.get(id);
      if (!row) throw new SiteBuildError("executorMissing", 404);
      remote.set(id, { ...row, phase: "failed", error: "cancelled" });
      return remote.get(id)!;
    },
    result: async () => result,
    logs: async () => "Fixture log\n",
  };
  const sourcePort = {
    authorize: () => {
      if (denied) throw new SiteBuildError("notFound", 404);
    },
    capture: async () => ({ input, sources }),
  };
  const reconciler = new SiteBuildReconciler(jobs, artifacts, executor, () => {});
  const service = new SiteBuildService(sourcePort, jobs, artifacts, executor, null);
  return {
    root,
    db,
    jobs,
    artifacts,
    reconciler,
    service,
    executor,
    remote,
    calls,
    sourcePort,
    lose: () => {
      loseAck = true;
    },
    deny: () => {
      denied = true;
    },
    async close() {
      reconciler.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("build intent rejects execution options and keeps stable request identity", async () => {
  const f = await fixture();
  try {
    const value = request();
    expect(() => siteBuildRequest({ ...value, image: "untrusted:image" })).toThrow();
    expect(() => siteBuildRequest({ ...value, url: "https://example.com/path" })).toThrow();
    const first = await f.service.start(value);
    expect((await f.service.start(value)).id).toBe(first.id);
    await expect(f.service.start({ ...value, title: "Other title" })).rejects.toThrow("idempotencyConflict");
    expect(f.jobs.input(first.id).documents[0]!.content).toBe("Saved source");
    f.deny();
    await expect(f.service.detail(first.id)).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
});
test("lost acknowledgement resumes the same execution ID after application restart", async () => {
  const f = await fixture();
  try {
    const job = await f.service.start(request());
    f.lose();
    await f.reconciler.tick();
    expect(f.jobs.get(job.id).connection).toBe("retrying");
    f.reconciler.stop();
    const resumed = new SiteBuildReconciler(f.jobs, f.artifacts, f.executor, () => {});
    try {
      await resumed.tick();
      expect(f.calls).toEqual([job.id, job.id]);
      expect(f.remote.size).toBe(1);
      f.remote.set(job.id, { ...f.remote.get(job.id)!, phase: "completed" });
      await resumed.tick();
      const completed = await f.service.detail(job.id);
      expect(completed.phase).toBe("completed");
      expect(completed.artifactAvailable).toBe(true);
      expect(await f.service.logs(job.id)).toBe("Fixture log\n");
      expect(() => f.jobs.input(job.id)).toThrow("snapshotUnavailable");
      expect(Buffer.from(unzipSync(await f.service.download(job.id))["index.html"]!).toString()).toContain(
        "Saved output",
      );
    } finally {
      resumed.stop();
    }
  } finally {
    await f.close();
  }
});
test("cancel before dispatch never starts a worker and failed builds are not replayed", async () => {
  const f = await fixture();
  try {
    const first = await f.service.start(request());
    await f.service.cancel(first.id);
    await f.reconciler.tick();
    expect((await f.service.detail(first.id)).phase).toBe("cancelled");
    expect(f.calls).toEqual([]);
    const second = await f.service.start(request());
    await f.reconciler.tick();
    f.remote.set(second.id, { ...f.remote.get(second.id)!, phase: "failed", error: "executorRestarted" });
    await f.reconciler.tick();
    await f.reconciler.tick();
    expect((await f.service.detail(second.id)).error).toBe("executorRestarted");
    expect(f.calls).toEqual([second.id]);
    await f.service.remove(first.id);
    await expect(f.service.detail(first.id)).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
});
test("reconciliation rejects mismatched snapshots and enforces generated-output retention", async () => {
  const f = await fixture();
  try {
    const job = await f.service.start(request());
    await f.reconciler.tick();
    f.remote.set(job.id, { ...f.remote.get(job.id)!, inputHash: "b".repeat(64) });
    await f.reconciler.tick();
    expect((await f.service.detail(job.id)).phase).toBe("failed");
    expect((await f.service.detail(job.id)).error).toBe("executorProtocol");
    const old = await f.service.start(request());
    await f.artifacts.put(old.id, artifact({ "index.html": "Old output" }));
    f.jobs.update(old.id, {
      phase: "completed",
      artifactAvailable: true,
      outputBytes: 10,
    });
    const oldRecord = { ...f.jobs.get(old.id), createdAt: Date.now() - 15 * 86400000 };
    f.db.query("UPDATE site_builds SET record=? WHERE id=?").run(JSON.stringify(oldRecord), old.id);
    await new SiteBuildRetention(f.jobs, f.artifacts).prune();
    expect((await f.service.detail(old.id)).artifactAvailable).toBe(false);
    await expect(f.artifacts.read(old.id)).rejects.toThrow("artifactUnavailable");
    expect((await f.service.detail(old.id)).sources[0]!.revisionId).toBe(revisionId);
  } finally {
    await f.close();
  }
});
test("Markdown asset references preserve code and expand reusable image definitions", () => {
  const id = randomUUID(),
    url = `/api/document-assets/content?id=${id}`;
  const source = `---\ntitle: fixture\n---\n\n\`![example](${url})\`\n\n\`\`\`md\n![example](${url})\n\`\`\`\n\n> ![actual](${url})\n\n![reference][cover]\n\n[cover]: ${url} "Caption"\n`;
  const parsed = buildImageReferences(source),
    rewritten = parsed.rewrite(new Map([[id, "/docs/assets/original.png"]]));
  expect(parsed.assets).toEqual([id]);
  expect(rewritten).toContain(`\`![example](${url})\``);
  expect(rewritten).toContain(`\`\`\`md\n![example](${url})\n\`\`\``);
  expect(rewritten).toContain("> ![actual](/docs/assets/original.png)");
  expect(rewritten).toContain('![reference](/docs/assets/original.png "Caption")');
});
test("corrupt artifacts fail permanently and retention removes only owned orphan files", async () => {
  const f = await fixture();
  try {
    const job = await f.service.start(request());
    await f.reconciler.tick();
    f.remote.set(job.id, { ...f.remote.get(job.id)!, phase: "completed" });
    f.executor.result = async () => {
      const output = artifact({ "index.html": "Original output" });
      output.files[0]!.data = Buffer.from("Tampered output").toString("base64");
      return output;
    };
    await f.reconciler.tick();
    expect((await f.service.detail(job.id)).error).toBe("artifactDigestMismatch");
    expect((await f.service.detail(job.id)).phase).toBe("failed");
    await f.reconciler.tick();
    expect(f.calls).toEqual([job.id]);
    const orphan = randomUUID(),
      active = await f.service.start(request());
    await f.artifacts.put(orphan, artifact({ "index.html": "Orphan" }));
    await f.artifacts.put(active.id, artifact({ "index.html": "Pending collection" }));
    await writeFile(join(f.root, "unrelated.txt"), "Do not remove");
    await new SiteBuildRetention(f.jobs, f.artifacts).prune();
    await expect(f.artifacts.read(orphan)).rejects.toThrow("artifactUnavailable");
    expect((await f.artifacts.read(active.id)).files).toHaveLength(1);
    expect(await Bun.file(join(f.root, "unrelated.txt")).text()).toBe("Do not remove");
  } finally {
    await f.close();
  }
});
test("artifact preview rewrites local navigation and strips executable and external resources", async () => {
  const f = await fixture();
  try {
    const job = await f.service.start(request());
    await f.artifacts.put(
      job.id,
      artifact({
        "index.html":
          '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="/docs/style.css"></head><body onload="alert(1)"><script>fetch("/api/config")</script><a href="/docs/about/">About</a><a href="https://evil.example">External</a><img src="https://evil.example/pixel"><iframe src="/api/config"></iframe></body></html>',
        "style.css": 'body{background:url("/docs/picture.png")}',
        "picture.png": "fixture",
        "about/index.html": "<h1>About</h1>",
      }),
    );
    f.jobs.update(job.id, { phase: "completed", artifactAvailable: true });
    const preview = new SiteBuildPreview(f.service, f.artifacts),
      html = (await preview.file(job.id, "index.html")).bytes.toString();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("refresh");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("About");
    expect(html).not.toContain("href=");
    expect(await preview.pages(job.id)).toEqual(["index.html", "about/index.html"]);
    expect((await preview.file(job.id, "style.css")).bytes.toString()).toContain("data:image/png;base64,");
    expect(previewPolicy).toContain("script-src 'none'");
    expect(previewPolicy).toContain("sandbox;");
    await expect(preview.file(job.id, "../index.html")).rejects.toThrow("artifactUnavailable");
  } finally {
    await f.close();
  }
});
test("HTTP executor authenticates only its configured origin and validates returned identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-executor-client-")),
    token = "a".repeat(64),
    file = join(root, "token");
  await writeFile(file, token, { mode: 0o600 });
  const job = request();
  try {
    const calls: { url: string; token: string | null; redirect?: string }[] = [];
    const fetcher = async (resource: string, options?: RequestInit) => {
      calls.push({
        url: String(resource),
        token: new Headers(options?.headers).get("Authorization"),
        redirect: options?.redirect,
      });
      return Response.json({
        id: job.id,
        engine: "hexo",
        inputHash: hashBuildInput(input),
        phase: "running",
        createdAt: 1,
        updatedAt: 1,
      });
    };
    const client = new HttpSiteExecutor("https://executor.example", file, fetcher);
    expect((await client.start(job.id, input)).id).toBe(job.id);
    expect(calls).toEqual([
      { url: `https://executor.example/v1/builds/${job.id}`, token: `Bearer ${token}`, redirect: "error" },
    ]);
    await expect(client.status(randomUUID())).rejects.toThrow("executorProtocol");
    expect(() => new HttpSiteExecutor("https://name:secret@executor.example", file)).toThrow();
    const oversized = new HttpSiteExecutor(
      "https://executor.example",
      file,
      async () => new Response("a".repeat(100_000)),
    );
    await expect(oversized.status(job.id)).rejects.toThrow("executorProtocol");
    for (const [internal, publicCode] of [
      ["imageNotAvailableLocally", "imageUnavailable"],
      ["incompatibleWorkerImage", "incompatibleImage"],
      ["registryCredentialsInvalid", "registryCredentialsUnavailable"],
      ["registryCredentialHelperUnsupported", "registryHelperUnsupported"],
      ["workerOutputTooLarge", "outputTooLarge"],
      ["daemon response with a private token", "buildFailed"],
    ]) {
      const failing = new HttpSiteExecutor("https://executor.example", file, async () =>
        Response.json({
          id: job.id,
          engine: "hexo",
          inputHash: hashBuildInput(input),
          phase: "failed",
          createdAt: 1,
          updatedAt: 2,
          error: internal,
        }),
      );
      expect((await failing.status(job.id)).error).toBe(publicCode);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
