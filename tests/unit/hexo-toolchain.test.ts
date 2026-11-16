import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEXO_RUNTIME_DEPENDENCIES, DEFAULT_THEME_DEPENDENCIES } from "../../src/shared/builds/toolchain.js";
import {
  HEXO_STYLUS_PROTOCOL,
  rendererRequirements,
  resourceBuildRequirements,
} from "../../src/shared/builds/capabilities.js";
import { RESOURCE_BUILD_PROTOCOL } from "../../src/shared/builds/resources.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import type { DockerApi } from "../../src/executor/docker/api.js";
import { HttpSiteExecutor } from "../../src/server/builds/adapters/http-executor.js";
import { resourceBuildFixture } from "../support/resource-build.js";
import { scaffold } from "../../src/document-worker/scaffold.js";

test("every default Hexo renderer and optional preset is pinned in the image toolchain manifest", async () => {
  const manifest = JSON.parse(await readFile("deploy/documents/toolchain/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries({ ...HEXO_RUNTIME_DEPENDENCIES, ...DEFAULT_THEME_DEPENDENCIES }))
    expect(manifest.dependencies[name]).toBe(version);
  expect(Object.isFrozen(HEXO_RUNTIME_DEPENDENCIES)).toBe(true);
});

test("Stylus capability is derived from frozen Hexo files and old private images remain usable for other inputs", async () => {
  const files = [{ path: "source/css/style.styl" }];
  expect(rendererRequirements("hexo", files)).toEqual({ hexoStylus: true });
  expect(rendererRequirements("docusaurus", files)).toEqual({});
  const labels: Record<string, string> = {
      "ai.hiforce.panda.build-protocol": "1",
      "ai.hiforce.panda.resource-build-protocol": "2",
      "ai.hiforce.panda.engine.hexo": "8.1.1",
    },
    api = {
      call: async () => ({
        status: 200,
        data: Buffer.from(JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: labels } })),
      }),
    } as unknown as DockerApi,
    selection = { reference: "harbor.example.test/team/custom-worker:4", pullPolicy: "never" as const },
    { input } = await resourceBuildFixture();
  await expect(
    resolveWorkerImage(api, selection, "hexo", { requirements: resourceBuildRequirements(input, files) }),
  ).rejects.toThrow("hexoStylusWorkerRequired");
  expect(
    (await resolveWorkerImage(api, selection, "hexo", { requirements: resourceBuildRequirements(input, []) }))
      .reference,
  ).toBe(selection.reference);
  labels["ai.hiforce.panda.hexo-stylus-protocol"] = "1";
  expect(
    (await resolveWorkerImage(api, selection, "hexo", { requirements: resourceBuildRequirements(input, files) })).id,
  ).toBe("sha256:" + "a".repeat(64));
});

test("the HTTP resource boundary refuses old executors before upload and accepts the advertised Stylus protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-stylus-capabilities-"));
  try {
    const token = join(root, "token");
    await writeFile(token, "a".repeat(64));
    const { request } = await resourceBuildFixture({
        "layout/index.ejs": "<h1>Theme</h1>",
        "source/style.styl": "body\n  color red",
      }),
      id = randomUUID();
    let starts = 0,
      features = [RESOURCE_BUILD_PROTOCOL];
    const remote = new HttpSiteExecutor("http://127.0.0.1:1234", token, async (url) => {
      if (url.includes("/v2/builds/")) {
        starts++;
        return Response.json({
          id,
          engine: "hexo",
          inputHash: request.digest,
          phase: "queued",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Response.json({ protocol: 1, engines: { hexo: "8.1.1" }, features });
    });
    await expect(remote.startResource(id, request)).rejects.toThrow("hexoStylusWorkerRequired");
    expect(starts).toBe(0);
    features = [RESOURCE_BUILD_PROTOCOL, HEXO_STYLUS_PROTOCOL];
    expect((await remote.startResource(id, request)).id).toBe(id);
    expect(starts).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a claimed renderer label cannot substitute for installed Stylus metadata at the worker boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-stylus-worker-"));
  try {
    const { request } = await resourceBuildFixture({
        "layout/index.ejs": "<h1>Theme</h1>",
        "source/style.styl": "body\n  color red",
      }),
      toolchain = join(root, "toolchain"),
      metadata = join(toolchain, "node_modules/hexo-renderer-stylus/package.json");
    await expect(scaffold(request, join(root, "missing-site"), toolchain)).rejects.toThrow(
      "themeDependencyUnavailable",
    );
    await mkdir(join(toolchain, "node_modules/hexo-renderer-stylus"), { recursive: true });
    await writeFile(metadata, JSON.stringify({ version: "2.0.0" }));
    await expect(scaffold(request, join(root, "wrong-site"), toolchain)).rejects.toThrow("themeDependencyUnavailable");
    await writeFile(metadata, JSON.stringify({ version: "3.0.1" }));
    await scaffold(request, join(root, "valid-site"), toolchain);
    expect(
      JSON.parse(await readFile(join(root, "valid-site/package.json"), "utf8")).dependencies["hexo-renderer-stylus"],
    ).toBe("3.0.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
