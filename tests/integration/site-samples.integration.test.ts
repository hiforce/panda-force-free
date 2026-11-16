import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { siteSampleDefinition } from "../support/site-sample-fixture.js";
import type { TemplateDraft } from "../../src/shared/plugins/library.js";
import type { PluginInstallReview } from "../../src/shared/plugins/registry.js";
import type { SiteSampleBuild } from "../../src/shared/plugins/site-samples.js";

test("website samples authenticate, recover through executor transport and feed immutable template proof without publication", async () => {
  const executor = await createSampleExecutorHttp();
  const app = await createAppFixture({
    extraEnvironment({ dir }) {
      const path = join(dir, "sample-token");
      writeFileSync(path, executor.token, { mode: 0o600 });
      return { PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url, PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: path };
    },
  });
  const cookies = new Map<string, string>();
  async function call<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    origin?: string,
  ) {
    const response = await fetch(app.base + path, {
      method,
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return { status: response.status, body: (await response.json()) as T };
  }
  async function completed(id: string) {
    return waitFor(async () => {
      const response = await call<{ build: SiteSampleBuild }>("/api/site-samples/detail?id=" + id);
      return response.body.build.phase === "completed" && response.body.build;
    });
  }
  try {
    expect((await call("/api/site-samples")).status).toBe(401);
    await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    expect((await call("/api/site-samples")).status).toBe(403);
    await call("/api/auth/setup", { username: "fixture-owner" });
    const source = { kind: "catalog", engine: "hexo", reference: "panda.reader@1.0.0" },
      id = randomUUID();
    expect((await call("/api/site-samples", { id, source }, "POST", "https://another.example")).status).toBe(401);
    expect((await call<{ builds: SiteSampleBuild[] }>("/api/site-samples")).body.builds).toEqual([]);
    expect((await call("/api/site-samples", { id, source, actor: "forged" })).status).toBe(400);
    const created = await call<{ build: SiteSampleBuild }>("/api/site-samples", { id, source });
    expect(created.status).toBe(202);
    expect((await call<{ build: SiteSampleBuild }>("/api/site-samples", { id, source })).body.build.id).toBe(id);
    await waitFor(() => executor.gates.has(id));
    await app.stop();
    await app.start();
    expect((await call<{ build: SiteSampleBuild }>("/api/site-samples/lookup", { source })).body.build.id).toBe(id);
    executor.release(id);
    const done = (await completed(id)) as SiteSampleBuild;
    expect(done.artifactAvailable).toBe(true);
    expect(done.theme.id).toBe("panda.reader");
    expect(JSON.stringify(done)).not.toContain(executor.token);
    expect(JSON.stringify(done)).not.toContain(app.dir);
    const artifact = await fetch(app.base + `/api/site-samples/preview/${id}/index.html`, {
      headers: { cookie: [...cookies.values()].join("; ") },
    });
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-security-policy")).toContain("sandbox");
    const html = await artifact.text();
    expect(html).toContain("<style>h1{color:#123456}");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("https://private.invalid");
    expect(executor.inputs.size).toBe(1);

    const definition = siteSampleDefinition();
    definition.package.manifest.siteThemes = definition.package.manifest.siteThemes.slice(0, 1);
    definition.fixtures = definition.fixtures.slice(0, 1);
    let draft = (await call<{ draft: TemplateDraft }>("/api/template-library", definition)).body.draft;
    const request = {
      id: randomUUID(),
      source: { kind: "draft", id: draft.id, revision: draft.revision, fixtureId: "journal" },
    };
    expect((await call("/api/site-samples", request)).status).toBe(403);
    const review = (await call<PluginInstallReview>("/api/document-packages/review", draft.definition.package)).body;
    await call("/api/document-packages/install", {
      package: draft.definition.package,
      approval: { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
    });
    expect((await call("/api/site-samples", request)).status).toBe(202);
    await waitFor(() => executor.gates.has(request.id));
    executor.release(request.id);
    await completed(request.id);
    const preview = await call<{ actualDigest: string; state: string; siteEvidence: { runId: string } }>(
      "/api/template-library/preview",
      { id: draft.id, fixtureId: "journal" },
    );
    expect(preview.body.state).toBe("unreviewed");
    expect(preview.body.siteEvidence.runId).toBe(request.id);
    draft = (
      await call<{ draft: TemplateDraft }>("/api/template-library/baseline", {
        id: draft.id,
        revision: draft.revision,
        fixtureId: "journal",
        digest: preview.body.actualDigest,
      })
    ).body.draft;
    draft = (
      await call<{ draft: TemplateDraft }>("/api/template-library/validate", { id: draft.id, revision: draft.revision })
    ).body.draft;
    expect(draft.validation?.passed).toBe(true);
    expect(executor.inputs.size).toBe(2);
    const lookup = (
      await call<{ build: SiteSampleBuild }>("/api/site-samples/lookup", {
        source: { ...request.source, revision: draft.revision },
      })
    ).body.build;
    expect(lookup.id).toBe(request.id);
    const forbidden = await call("/api/site-samples", {
      id: randomUUID(),
      source: { ...source, image: "private.invalid/unreviewed" },
    });
    expect(forbidden.status).toBe(400);
    expect((await call("/api/site-samples/cancel", { id: request.id })).status).toBe(200);
    expect((await call("/api/site-samples/detail?id=" + request.id, undefined, "DELETE")).status).toBe(200);
    expect((await call("/api/site-samples/detail?id=" + request.id)).status).toBe(404);
    const failed = randomUUID();
    expect((await call("/api/site-samples", { id: failed, source })).status).toBe(202);
    await waitFor(() => executor.gates.has(failed));
    executor.release(failed, true);
    const failure = (await waitFor(async () => {
      const response = await call<{ build: SiteSampleBuild }>("/api/site-samples/detail?id=" + failed);
      return response.body.build.phase === "failed" && response.body.build;
    })) as SiteSampleBuild;
    expect(failure.error).toBe("buildFailed");
    const cancelling = randomUUID();
    await call("/api/site-samples", { id: cancelling, source });
    await waitFor(() => executor.gates.has(cancelling));
    expect((await call("/api/site-samples/cancel", { id: cancelling })).status).toBe(200);
    const cancelled = (await waitFor(async () => {
      const response = await call<{ build: SiteSampleBuild }>("/api/site-samples/detail?id=" + cancelling);
      return response.body.build.phase === "cancelled" && response.body.build;
    })) as SiteSampleBuild;
    expect(cancelled.artifactAvailable).toBe(false);
    expect(executor.inputs.size).toBe(4);
  } finally {
    await app.dispose();
    await executor.stop();
  }
}, 60000);
