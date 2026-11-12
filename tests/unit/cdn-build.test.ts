import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishAssets, sha256, writeCdnOutput, verifyCdn } from "../../scripts/cdn/publish.mjs";
import { cdnConfiguration } from "../../scripts/cdn/storage.mjs";

function fixture() {
  const objects = new Map<string, Buffer>();
  const bodies = new Map<string, Buffer>();
  let writes = 0;
  const storage = {
    get: async (key: string) => objects.get(key) || null,
    put: async (key: string, bytes: Buffer) => {
      objects.set(key, bytes);
      writes++;
    },
  };
  const assets = new Map([
    ["/fonts/body.woff2", Buffer.from("font")],
    ["/icon.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["/style.css", Buffer.from('@font-face{src:url(fonts/body.woff2)}body{background:url("/icon.svg?v=old")}')],
    ["/lazy.js", Buffer.from("export const lazy = true;")],
    ["/worker.js", Buffer.from("self.onmessage=()=>{};")],
    [
      "/feature.bundle.js",
      Buffer.from(
        'export const open = () => import("./lazy.js?retry=1");new Worker(new URL("./worker.js",import.meta.url),{type:"module"});',
      ),
    ],
    ["/locales/zh-CN.json", Buffer.from('{"hello":"你好"}')],
  ]);
  const options = {
    assets,
    storage,
    onAsset: (path: string, body: Buffer) => bodies.set(path, body),
    baseUrl: "https://cdn.example.com",
    prefix: "app/static",
    now: new Date("2026-11-12T00:00:00Z"),
    verify: async (url: string, bytes: Buffer) => {
      expect(objects.get(new URL(url).pathname.slice(1))).toEqual(bytes);
    },
  };
  return { options, objects, bodies, writes: () => writes };
}

test("rewrites feature chunks, workers, CSS fonts and images before hashing and reuses objects across months", async () => {
  const f = fixture();
  const first = await publishAssets(f.options);
  expect(first.uploaded).toBe(f.options.assets.size);
  for (const record of Object.values(first.assets) as any[]) {
    expect(record.key).toContain("/2026/11/");
    expect(sha256(f.objects.get(record.key))).toBe(record.sha256);
  }
  const css = f.objects.get(first.assets["/style.css"].key)!.toString();
  expect(css).toContain(first.assets["/fonts/body.woff2"].url);
  expect(css).toContain(first.assets["/icon.svg"].url);
  const js = f.objects.get(first.assets["/feature.bundle.js"].key)!.toString();
  expect(js).toContain(first.assets["/lazy.js"].url);
  expect(js).toContain(first.assets["/worker.js"].url);
  const writes = f.writes();
  const next = await publishAssets({ ...f.options, now: new Date("2026-12-01T00:00:00Z") });
  expect(next.uploaded).toBe(0);
  expect(next.reused).toBe(f.options.assets.size);
  expect(next.assets).toEqual(first.assets);
  expect(f.writes()).toBe(writes);
  f.options.assets.set("/lazy.js", Buffer.from("export const lazy = false;"));
  const changed = await publishAssets(f.options);
  expect(changed.uploaded).toBe(2);
  expect(changed.assets["/style.css"]).toEqual(first.assets["/style.css"]);
});

test("fails on missing or cyclic dependencies and corrupt objects", async () => {
  const f = fixture();
  f.options.assets.set("/bad.js", Buffer.from('import("/missing.bundle.js")'));
  await expect(publishAssets(f.options)).rejects.toThrow("Missing static dependency");
  f.options.assets.delete("/bad.js");
  f.options.assets.set("/lazy.js", Buffer.from('import("./feature.bundle.js")'));
  await expect(publishAssets(f.options)).rejects.toThrow("Cyclic static imports");
  const g = fixture();
  const first = await publishAssets(g.options);
  g.objects.set(first.assets["/icon.svg"].key, Buffer.from("corrupt"));
  await expect(publishAssets(g.options)).rejects.toThrow("differs from hash index");
});

test("keeps HTML and web-app scope local while exposing only verified static URLs", async () => {
  const f = fixture(),
    manifest = await publishAssets(f.options);
  const root = mkdtempSync(join(tmpdir(), "panda-cdn-test-"));
  try {
    mkdirSync(join(root, "source"));
    writeFileSync(
      join(root, "source/index.html"),
      '<html><head><link href="/manifest.webmanifest"><link href="/style.css"></head><body><script type="module" src="/feature.bundle.js"></script></body></html>',
    );
    writeFileSync(
      join(root, "source/manifest.webmanifest"),
      JSON.stringify({ id: "/", scope: "/", start_url: "/workspace", icons: [{ src: "/icon.svg?v=1" }] }),
    );
    const output = join(root, "output");
    writeCdnOutput({ source: join(root, "source"), output, manifest, bodies: f.bodies });
    for (const [path, record] of Object.entries(manifest.assets) as [string, any][]) {
      expect(sha256(readFileSync(join(output, path.slice(1))))).toBe(record.sha256);
    }
    const html = readFileSync(join(output, "index.html"), "utf8");
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('id="pandaStaticAssets"');
    expect(html).toContain(manifest.assets["/feature.bundle.js"].url);
    const web = JSON.parse(readFileSync(join(output, "manifest.webmanifest"), "utf8"));
    expect(web.start_url).toBe("/workspace");
    expect(web.icons[0].src).toBe(manifest.assets["/icon.svg"].url);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CDN configuration is opt-in and never accepts credentials in the viewer URL", () => {
  expect(cdnConfiguration({})).toBeNull();
  expect(() => cdnConfiguration({ PANDA_FORCE_CDN_BASE_URL: "https://user:secret@cdn.example.com" })).toThrow();
  expect(() => cdnConfiguration({ PANDA_FORCE_CDN_BASE_URL: "https://cdn.example.com" })).toThrow(
    "PANDA_FORCE_CDN_BUCKET",
  );
});

test("CDN verification fails closed when browser CORS headers are missing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("test", { headers: { "content-type": "text/javascript" } })) as any;
  try {
    await expect(verifyCdn("https://cdn.example.com/test.js", Buffer.from("test"), "text/javascript")).rejects.toThrow(
      "CORS verification failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});
