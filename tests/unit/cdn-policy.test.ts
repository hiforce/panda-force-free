import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_BUNDLES } from "../../src/shared/client-entrypoints.js";
import { inspectCompiledCdn } from "../../src/server/http/cdn-policy.js";
import { publishAssets, writeCdnOutput } from "../../scripts/cdn/publish.mjs";
import { renderCdnDockerfile } from "../../scripts/build/prepare-cdn-image.js";
import { cdnSourceImage } from "../../scripts/build/cdn-image.js";

test("local installation remains the default and explicit CDN mode rejects a missing build", () => {
  const root = mkdtempSync(join(tmpdir(), "cdn-policy-local-"));
  try {
    expect(inspectCompiledCdn(root)).toBeNull();
    expect(() => inspectCompiledCdn(root, { required: true })).toThrow("cdnBuildRequired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CDN startup requires every emitted asset, lazy entry, delivered byte and embedded URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdn-policy-compiled-")),
    source = join(root, "source"),
    output = join(root, "public"),
    assets = new Map(CLIENT_BUNDLES.map((path) => [path, Buffer.from("export const ready = true;")])),
    objects = new Map<string, Buffer>(),
    bodies = new Map<string, Buffer>();
  assets.set("/feature.css", Buffer.from("body{color:inherit}"));
  try {
    mkdirSync(source);
    writeFileSync(
      join(source, "index.html"),
      '<html><head></head><body><script src="/auth-bootstrap.js"></script></body></html>',
    );
    writeFileSync(join(source, "manifest.webmanifest"), JSON.stringify({ start_url: "/workspace", icons: [] }));
    const manifest = await publishAssets({
      assets,
      baseUrl: "https://cdn.example.com",
      prefix: "app/static",
      storage: {
        get: async (key: string) => objects.get(key) || null,
        put: async (key: string, bytes: Buffer) => {
          objects.set(key, bytes);
        },
      },
      verify: async () => {},
      onAsset: (path: string, body: Buffer) => bodies.set(path, body),
    });
    writeCdnOutput({ source, output, manifest, bodies });
    expect(inspectCompiledCdn(output, { required: true, baseUrl: "https://cdn.example.com" })?.assetCount).toBe(
      assets.size,
    );
    const complete = readFileSync(join(output, "cdn-manifest.json"), "utf8");
    delete manifest.assets["/gadget-document.bundle.js"];
    writeFileSync(join(output, "cdn-manifest.json"), JSON.stringify(manifest));
    expect(() => inspectCompiledCdn(output, { required: true })).toThrow("cdnBuildRequired");
    writeFileSync(join(output, "cdn-manifest.json"), complete);
    expect(() => inspectCompiledCdn(output, { baseUrl: "https://wrong.example.com" })).toThrow("cdnBuildRequired");
    writeFileSync(join(output, "http-client.js"), "corrupt");
    expect(() => inspectCompiledCdn(output)).toThrow("cdnBuildRequired");
    writeFileSync(join(output, "http-client.js"), bodies.get("/http-client.js")!);
    writeFileSync(join(output, "index.html"), "<html><head></head></html>");
    expect(() => inspectCompiledCdn(output)).toThrow("cdnBuildRequired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the reusable CDN build follows each source revision and verifies its artifact without replacing the root recipe", () => {
  const options = {
    repository: "registry.example/app",
    baseUrl: "https://cdn.example.com",
    commit: "a".repeat(40),
    sourceSha256: "b".repeat(64),
  };
  const first = renderCdnDockerfile(options);
  expect(first).toContain(
    "FROM " + cdnSourceImage(options.repository, options.baseUrl, "pandaforce/static", options.sourceSha256),
  );
  expect(first).toContain(options.sourceSha256);
  expect(first).toContain("inspectCompiledCdn");
  const documentationOnly = renderCdnDockerfile({ ...options, commit: "c".repeat(40) });
  expect(documentationOnly.split("\n")[0]).toBe(first.split("\n")[0]);
  expect(documentationOnly).toContain('revision="' + "c".repeat(40) + '"');
  expect(renderCdnDockerfile({ ...options, sourceSha256: "d".repeat(64) }).split("\n")[0]).not.toBe(
    first.split("\n")[0],
  );
  expect(renderCdnDockerfile({ ...options, prefix: "owner/custom" }).split("\n")[0]).not.toBe(first.split("\n")[0]);
  expect(renderCdnDockerfile({ ...options, baseUrl: "https://other.example.com" }).split("\n")[0]).not.toBe(
    first.split("\n")[0],
  );
  expect(renderCdnDockerfile({ ...options, configurationKey: "e".repeat(64) }).split("\n")[0]).not.toBe(
    first.split("\n")[0],
  );
  expect(() => renderCdnDockerfile({ ...options, repository: "bad\nRUN echo injected" })).toThrow();
  expect(() => renderCdnDockerfile({ ...options, baseUrl: "https://user:secret@cdn.example.com" })).toThrow();
});
