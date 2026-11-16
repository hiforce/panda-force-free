import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceBuildFixture, resourceBuildBase } from "../support/resource-build.js";
import { ResourceBuildRequest, RESOURCE_BUILD_LIMITS } from "../../src/shared/builds/resources.js";
import {
  encodeResourceBuild,
  decodeResourceBuild,
  RESOURCE_FRAME_HEADER,
} from "../../src/shared/builds/resource-frame.js";
import { WorkerInputCollector } from "../../src/shared/builds/worker-input.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { scaffold } from "../../src/document-worker/scaffold.js";
import { resolveWorkerImage } from "../../src/executor/docker/images.js";
import { DockerApi } from "../../src/executor/docker/api.js";
import { RESOURCE_FRAME_INDEX } from "../../src/shared/builds/resource-frame.js";

test("native binary requests preserve immutable provenance and exact resources beyond historical package limits", async () => {
  const f = await resourceBuildFixture({
      "large.bin": new Uint8Array(8 * 1024 * 1024 + 1).fill(17),
      "logo.bin": new Uint8Array([0, 10, 255]),
    }),
    bytes = encodeResourceBuild(f.request),
    pending = decodeResourceBuild(bytes);
  bytes.fill(0);
  const restored = await pending;
  expect(restored.digest).toBe(f.request.digest);
  expect(restored.tree.read("logo.bin")).toEqual(new Uint8Array([0, 10, 255]));
  expect(restored.tree.read("large.bin").length).toBe(8 * 1024 * 1024 + 1);
  expect(encodeResourceBuild(restored).length).toBeLessThan(restored.tree.byteLength + 4096);
  expect(Object.isFrozen(restored.descriptor.input.site)).toBe(true);
  expect(Object.isFrozen(restored.descriptor.theme.source)).toBe(true);
  const pendingFreeze = ResourceBuildRequest.create(f.input, f.theme, f.tree);
  f.input.documents[0]!.content = "Changed";
  f.theme.source.digest = "d".repeat(64);
  expect((await pendingFreeze).descriptor.input.documents[0]!.content).toBe("Native content");
});

test("resource frames reject truncation, trailing data, forged digests and hidden descriptor fields", async () => {
  const { request } = await resourceBuildFixture(),
    bytes = encodeResourceBuild(request);
  for (const changed of [bytes.subarray(0, bytes.length - 1), new Uint8Array([...bytes, 0])])
    await expect(decodeResourceBuild(changed)).rejects.toThrow("invalidResourceBuild");
  const corrupt = new Uint8Array(bytes);
  corrupt[corrupt.length - 1] = 1;
  await expect(decodeResourceBuild(corrupt)).rejects.toThrow("inputDigestMismatch");
  for (const field of ["treeDigest", "token"]) {
    const length = new DataView(bytes.buffer).getUint32(8, false),
      index = JSON.parse(
        new TextDecoder().decode(bytes.subarray(RESOURCE_FRAME_HEADER, RESOURCE_FRAME_HEADER + length)),
      );
    index[field] = "e".repeat(64);
    const header = new TextEncoder().encode(JSON.stringify(index)),
      changed = new Uint8Array(RESOURCE_FRAME_HEADER + header.length + request.tree.byteLength);
    changed.set(bytes.subarray(0, RESOURCE_FRAME_HEADER));
    new DataView(changed.buffer).setUint32(8, header.length, false);
    changed.set(header, RESOURCE_FRAME_HEADER);
    changed.set(bytes.subarray(RESOURCE_FRAME_HEADER + length), RESOURCE_FRAME_HEADER + header.length);
    await expect(decodeResourceBuild(changed)).rejects.toThrow("inputDigestMismatch");
  }
});

test("native build definitions reject command injection, dependency ranges, mismatched engines and undeclared source projections", async () => {
  const f = await resourceBuildFixture();
  for (const changed of [
    { command: "npm install" },
    { dependencies: { package: "latest" } },
    { engineVersion: "0.0.0" },
    { entry: "index.js" },
    { source: { ...f.theme.source, projectionDigest: "0".repeat(64) } },
  ])
    await expect(ResourceBuildRequest.create(f.input, { ...f.theme, ...changed }, f.tree)).rejects.toThrow();
  const forbidden = await ImmutableSourceTree.create([{ path: "node_modules/unsafe.js", bytes: new Uint8Array() }]);
  await expect(ResourceBuildRequest.create(f.input, f.theme, forbidden)).rejects.toThrow("invalidNativeTheme");
  await expect(ResourceBuildRequest.create(f.input, f.theme, await ImmutableSourceTree.create([]))).rejects.toThrow(
    "invalidNativeTheme",
  );
});

test("worker input framing handles every binary header boundary and keeps the legacy JSON line protocol", async () => {
  const { request } = await resourceBuildFixture(),
    frame = encodeResourceBuild(request);
  for (const size of [1, 2, 7, 8, 15, 16, 127]) {
    const collector = new WorkerInputCollector();
    for (let offset = 0; offset < frame.length; offset += size)
      expect(collector.push(frame.subarray(offset, offset + size))).toBe(offset + size >= frame.length);
    const restored = await collector.result();
    expect(restored instanceof ResourceBuildRequest).toBe(true);
    if (restored instanceof ResourceBuildRequest) expect(restored.digest).toBe(request.digest);
  }
  const legacy = new WorkerInputCollector(),
    input = resourceBuildBase();
  expect(legacy.push(new TextEncoder().encode(JSON.stringify(input) + "\n"))).toBe(true);
  expect(await legacy.result()).toEqual(input);
  const incomplete = new WorkerInputCollector();
  incomplete.push(frame.subarray(0, frame.length - 1));
  await expect(incomplete.result()).rejects.toThrow("missingInput");
  expect(() => new WorkerInputCollector().push(new Uint8Array([...frame, 0]))).toThrow("invalidResourceBuild");
});

test("native scaffold materializes binary copies and engine configuration without requiring a host theme directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-theme-scaffold-"));
  try {
    for (const engine of ["hexo", "docusaurus"] as const) {
      const f = await resourceBuildFixture(
          engine === "hexo"
            ? undefined
            : {
                "index.js": "module.exports=()=>({name:'native-theme'});",
                "source/logo.bin": new Uint8Array([0, 10, 255]),
              },
          engine,
        ),
        directory = join(root, engine);
      await scaffold(f.request, directory, "/missing-toolchain");
      const themeRoot = engine === "hexo" ? "themes/panda-installed" : "panda-theme";
      expect(new Uint8Array(await readFile(join(directory, themeRoot, "source/logo.bin")))).toEqual(
        new Uint8Array([0, 10, 255]),
      );
      if (engine === "hexo")
        expect(await readFile(join(directory, "_config.yml"), "utf8")).toContain('theme: "panda-installed"');
      else expect(await readFile(join(directory, "docusaurus.config.js"), "utf8")).toContain("./panda-theme/index.js");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native resource execution requires a matching actual worker image capability", async () => {
  const api = new DockerApi("/unused");
  let native = false;
  api.call = async () => ({
    status: 200,
    data: Buffer.from(
      JSON.stringify({
        Id: "sha256:" + "a".repeat(64),
        Config: {
          Labels: {
            "ai.hiforce.panda.build-protocol": "1",
            "ai.hiforce.panda.engine.hexo": "8.1.1",
            ...(native ? { "ai.hiforce.panda.resource-build-protocol": "2" } : {}),
          },
        },
      }),
    ),
  });
  await expect(
    resolveWorkerImage(api, { reference: "example/worker:1", pullPolicy: "never" }, "hexo", {
      requirements: { nativeResources: true },
    }),
  ).rejects.toThrow("resourceBuildWorkerRequired");
  native = true;
  expect(
    (
      await resolveWorkerImage(api, { reference: "example/worker:1", pullPolicy: "never" }, "hexo", {
        requirements: { nativeResources: true },
      })
    ).id,
  ).toBe("sha256:" + "a".repeat(64));
});

test("oversized resource headers and expanded inventories fail before unbounded worker input can be accumulated", async () => {
  const { request } = await resourceBuildFixture(),
    frame = encodeResourceBuild(request);
  for (const [offset, limit] of [
    [8, RESOURCE_FRAME_INDEX],
    [12, RESOURCE_BUILD_LIMITS.totalBytes],
  ]) {
    const header = new Uint8Array(frame.subarray(0, RESOURCE_FRAME_HEADER));
    new DataView(header.buffer).setUint32(offset!, limit! + 1, false);
    expect(() => new WorkerInputCollector().push(header)).toThrow("resourceBuildTooLarge");
  }
  const f = await resourceBuildFixture(),
    tree = await ImmutableSourceTree.create(
      Array.from({ length: 4097 }, (_, i) => ({ path: "file-" + i, bytes: new Uint8Array() })),
      { ...RESOURCE_BUILD_LIMITS, files: 5000 },
    );
  await expect(ResourceBuildRequest.create(f.input, f.theme, tree)).rejects.toThrow("resourceBuildTooLarge");
});
