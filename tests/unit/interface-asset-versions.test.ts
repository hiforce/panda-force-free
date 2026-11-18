import { fileURLToPath } from "node:url";
import { resolvePublicAsset } from "../../src/server/auth/security.js";
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createInterfaceAssets } from "../../src/server/http/interface-assets.js";
import { serveStaticAsset } from "../../src/server/http/static-assets.js";

test("unchanged HTML receives new resource URLs and ETags when its stylesheet or application changes", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-interface-"));
  try {
    const index = join(root, "index.html");
    writeFileSync(
      index,
      '<link rel="stylesheet" href="/page.css"><script type="module" src="/auth-bootstrap.js"></script>',
    );
    writeFileSync(join(root, "page.css"), "body{color:red}");
    writeFileSync(join(root, "auth-bootstrap.js"), 'await import("/app.bundle.js");');
    writeFileSync(join(root, "app.bundle.js"), 'console.log("first");');
    const first = createInterfaceAssets(root);
    expect(first.get(index)!.body.toString()).toMatch(/page.css\?v=[a-f0-9]{64}/);
    expect(first.get(index)!.body.toString()).toContain('integrity="sha256-');
    expect(first.get(join(root, "auth-bootstrap.js"))!.body.toString()).toMatch(/app.bundle.js\?v=[a-f0-9]{64}/);
    const respond = (assets: ReturnType<typeof createInterfaceAssets>, etag?: string) => {
      const output: any = {
        writeHead(status: number, headers: Record<string, string>) {
          this.status = status;
          this.headers = headers;
        },
        end(body: Buffer) {
          this.body = body;
        },
      };
      serveStaticAsset(
        { method: "GET", headers: etag ? { "if-none-match": etag } : {} },
        output,
        index,
        "text/html",
        assets.get(index),
      );
      return output;
    };
    const old = respond(first);
    expect(respond(first, old.headers.etag).status).toBe(304);
    writeFileSync(join(root, "page.css"), "body{color:blue}");
    writeFileSync(join(root, "app.bundle.js"), 'console.log("second");');
    const next = createInterfaceAssets(root),
      fresh = respond(next, old.headers.etag);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.etag).not.toBe(old.headers.etag);
    expect(fresh.body.toString()).not.toBe(old.body.toString());
    expect(next.get(join(root, "auth-bootstrap.js"))!.key).not.toBe(first.get(join(root, "auth-bootstrap.js"))!.key);
    const wrong: any = {
      writeHead(status: number, headers: Record<string, string>) {
        this.status = status;
        this.headers = headers;
      },
      end(body: unknown) {
        this.body = body;
      },
    };
    serveStaticAsset(
      { method: "GET", url: "/page.css?v=" + "0".repeat(64), headers: {} },
      wrong,
      join(root, "page.css"),
      "text/css",
    );
    expect(wrong.status).toBe(409);
    expect(wrong.headers["cache-control"]).toBe("no-store");
    expect(wrong.body).not.toContain("color:blue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy origin URLs redirect to compiled CDN assets without forwarding unrelated query data", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-interface-cdn-"));
  try {
    const file = join(root, "http-client.js"),
      body = "export const ready=true;";
    writeFileSync(file, body);
    const digest = createHash("sha256").update(body).digest("hex"),
      url = "https://cdn.example.com/app/static/2026/11/" + digest + ".js";
    writeFileSync(
      join(root, "cdn-manifest.json"),
      JSON.stringify({ schema: 1, assets: { "/http-client.js": { url, sha256: digest } } }),
    );
    const assets = createInterfaceAssets(root);
    const request = (path: string) => {
      const result: any = {
        writeHead(status: number, headers: unknown) {
          this.status = status;
          this.headers = headers;
        },
        end(body: unknown) {
          this.body = body;
        },
      };
      serveStaticAsset({ method: "GET", url: path, headers: {} }, result, file, "text/javascript", assets.get(file));
      return result;
    };
    const response = request("/http-client.js?retry=1&token=do-not-forward");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(url + "?retry=1");
    expect(response.body).toBeUndefined();
    expect(request("/http-client.js?v=" + "0".repeat(64)).status).toBe(409);
    expect(assets.get(join(root, "api-not-an-asset"))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every linked application stylesheet has a public static route", () => {
  const root = fileURLToPath(new URL("../../public/", import.meta.url)),
    html = readFileSync(join(root, "index.html"), "utf8");
  const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
    .map(([tag]) => /href="(\/[^"?]+\.css)"/.exec(tag)?.[1])
    .filter((value): value is string => !!value);
  expect(styles.length).toBeGreaterThan(10);
  for (const url of styles) expect(resolvePublicAsset(url, root)).toBe(join(root, url.slice(1)));
});
