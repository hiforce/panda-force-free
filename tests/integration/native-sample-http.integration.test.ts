import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createSampleExecutorHttp } from "../support/site-sample-http.js";
import { nativeSettings, nativeZipSource } from "../support/native-theme.js";
import type { SourceStageView } from "../../src/shared/packages/stages/contracts.js";
import type { NativeThemeReview, NativeThemeSnapshot } from "../../src/shared/templates/native/contracts.js";
import type { NativeSampleBuild } from "../../src/shared/builds/native-samples.js";

test("native samples cross authenticated HTTP, resume after lost executor acknowledgement and expose only private static previews", async () => {
  const executor = await createSampleExecutorHttp({ native: true }),
    app = await createAppFixture({
      extraEnvironment({ dir }) {
        const token = join(dir, "native-executor-token");
        writeFileSync(token, executor.token, { mode: 0o600 });
        return { PANDA_FORCE_BUILD_EXECUTOR_URL: executor.url, PANDA_FORCE_BUILD_EXECUTOR_TOKEN_FILE: token };
      },
    }),
    cookies = new Map<string, string>(),
    prefix = "/api/templates/native/samples";
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(app.base + path, {
      method,
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return response;
  }
  async function json<T>(path: string, body?: unknown, method?: string) {
    const response = await request(path, body, method),
      data = await response.json();
    expect(response.status).toBeLessThan(400);
    return data as T;
  }
  try {
    expect((await request(prefix)).status).toBe(401);
    await json("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    expect((await request(prefix)).status).toBe(403);
    await json("/api/auth/setup", { username: "fixture-owner" });
    const { bytes } = await nativeZipSource(),
      stage = await json<SourceStageView>("/api/package-sources", {
        purpose: "templates",
        operationId: randomUUID(),
        request: {
          source: {
            kind: "zip-upload",
            name: "native-sample.zip",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      });
    await json(
      "/api/package-sources/upload?" +
        new URLSearchParams({ purpose: "templates", id: stage.id, revision: String(stage.revision) }),
      bytes,
    );
    const ready = await waitFor(async () => {
        const value = await json<SourceStageView>("/api/package-sources/task?purpose=templates&id=" + stage.id);
        if (value.state === "failed") throw Error(value.failure!);
        return value.state === "ready" && value;
      }),
      input = { source: { id: ready.id, sha256: ready.digest!, root: "theme" }, settings: nativeSettings() },
      review = await json<NativeThemeReview>("/api/templates/native/review", input),
      installed = await json<{ current: NativeThemeSnapshot }>("/api/templates/native/install", {
        ...input,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          permissions: ["build:theme-code"],
          licenseAcknowledged: true,
        },
      }),
      theme = installed.current.themes[0]!,
      ref = { id: theme.id, version: theme.version, digest: theme.digest },
      command = { id: randomUUID(), theme: ref };
    expect((await request(prefix, command, "POST", { origin: "https://untrusted.example" })).status).toBe(401);
    expect((await request(prefix, { ...command, actor: "forged" })).status).toBe(400);
    expect((await request(prefix + "?actor=forged")).status).toBe(400);
    executor.faults.statusUnavailable = true;
    const queued = (await json<{ build: NativeSampleBuild }>(prefix, command)).build;
    expect(queued.phase).toBe("queued");
    expect((await json<{ build: NativeSampleBuild }>(prefix + "/lookup", { source: ref })).build.id).toBe(command.id);
    await app.stop();
    await app.start();
    expect((await json<{ build: NativeSampleBuild }>(prefix + "/detail?id=" + command.id)).build.inputHash).toBe(
      queued.inputHash,
    );
    executor.faults.loseStartAcknowledgement = true;
    executor.faults.statusUnavailable = false;
    await waitFor(() => executor.gates.has(command.id));
    await waitFor(async () => {
      const value = await json<{ build: NativeSampleBuild }>(prefix + "/detail?id=" + command.id);
      return value.build.connection === "retrying";
    });
    await json(
      "/api/templates/native/state",
      { reference: ref, action: "disable", expectedRevision: installed.current.revision },
      "PUT",
    );
    await json("/api/package-sources/remove", { purpose: "templates", id: ready.id, revision: ready.revision });
    await app.stop();
    await app.start();
    await waitFor(
      async () =>
        (await json<{ build: NativeSampleBuild }>(prefix + "/detail?id=" + command.id)).build.phase === "running",
    );
    executor.release(command.id);
    const done = await waitFor(async () => {
      const value = await json<{ build: NativeSampleBuild }>(prefix + "/detail?id=" + command.id);
      return value.build.phase === "completed" && value.build;
    });
    expect(done.inputHash).toBe(queued.inputHash);
    expect(done.artifactAvailable).toBe(true);
    expect(executor.resources.get(command.id)).toMatchObject({
      digest: queued.inputHash,
      paths: ["layout/index.ejs", "source/logo.bin"],
      logo: new Uint8Array([0, 10, 255]),
    });
    expect(executor.inputs.size).toBe(1);
    expect(JSON.stringify(done)).not.toContain(executor.token);
    expect(JSON.stringify(done)).not.toContain(app.dir);
    expect((await request(prefix, { id: randomUUID(), theme: ref })).status).toBe(403);
    expect((await json<{ build: NativeSampleBuild }>(prefix, command)).build.id).toBe(command.id);
    const pages = await json<{ pages: string[] }>(prefix + "/pages?id=" + command.id);
    expect(pages.pages).toEqual(["index.html", "sample/index.html"]);
    const preview = await request(prefix + `/preview/${command.id}/index.html`),
      html = await preview.text();
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toContain("no-store");
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(html).toContain("A fixed handbook");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("https://private.invalid");
    const privatePreview = await fetch(app.base + prefix + `/preview/${command.id}/index.html`);
    expect(privatePreview.status).toBe(401);
    const download = await request(prefix + "/download?id=" + command.id);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await request(prefix + "/detail?id=" + command.id, undefined, "DELETE")).status).toBe(200);
    expect((await request(prefix + "/detail?id=" + command.id)).status).toBe(404);
    expect((await request(prefix + `/preview/${command.id}/index.html`)).status).toBe(404);
    expect((await json<{ build: NativeSampleBuild }>(prefix, command)).build.phase).toBe("completed");
    expect(executor.inputs.size).toBe(1);
  } finally {
    await app.dispose();
    await executor.stop();
  }
}, 60000);
