import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { nativeSettings, nativeZipSource } from "../support/native-theme.js";
import type { SourceStageView } from "../../src/shared/packages/stages/contracts.js";
import type {
  NativeThemeReview,
  NativeThemeReceipt,
  NativeThemeSnapshot,
} from "../../src/shared/templates/native/contracts.js";

test("native theme HTTP routes require authenticated exact approvals and persist receipts across application restart", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>(),
    { bytes } = await nativeZipSource();
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {},
  ) {
    const result = await fetch(app.base + path, {
      method,
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }),
    });
    for (const cookie of result.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return result;
  }
  async function json<T>(path: string, body?: unknown, method?: string) {
    const result = await request(path, body, method);
    expect(result.status).toBeLessThan(400);
    return (await result.json()) as T;
  }
  try {
    expect((await request("/api/templates/native")).status).toBe(401);
    await json("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    await json("/api/auth/setup", { username: "fixture-owner" });
    const stage = await json<SourceStageView>("/api/package-sources", {
      purpose: "templates",
      operationId: randomUUID(),
      request: {
        source: {
          kind: "zip-upload",
          name: "native-theme.zip",
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
      return value.state === "ready" ? value : null;
    });
    const input = { source: { id: ready.id, sha256: ready.digest!, root: "theme" }, settings: nativeSettings() },
      review = await json<NativeThemeReview>("/api/templates/native/review", input),
      command = {
        ...input,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          permissions: ["build:theme-code"],
          licenseAcknowledged: true,
        },
      };
    const prepared = await json<{ settings: { engine: string }; licenseText: string; readmeText: string }>(
      "/api/templates/native/prepare",
      { source: input.source, engine: "hexo" },
    );
    expect(prepared.settings.engine).toBe("hexo");
    expect(prepared.licenseText).toBe("MIT fixture license");
    expect(prepared.readmeText).toBe("Native theme usage");
    expect(
      (
        await request("/api/templates/native/prepare", {
          source: { ...input.source, sha256: "0".repeat(64) },
          engine: "hexo",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("/api/templates/native/prepare", { source: input.source, engine: "hexo", actor: "forged" }))
        .status,
    ).toBe(400);
    expect(review.licenseText).toBe("MIT fixture license");
    expect(
      (await request("/api/templates/native/install", command, "POST", { origin: "https://untrusted.example" })).status,
    ).toBe(401);
    expect((await request("/api/templates/native/install", { ...command, actor: "forged" })).status).toBe(400);
    const denied = await request("/api/templates/native/install", {
      ...command,
      approval: { ...command.approval, licenseAcknowledged: false },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: "executionNotApproved",
      messageId: "templates.nativeApprovalRequired",
    });
    const installed = await json<{ receipt: NativeThemeReceipt; current: NativeThemeSnapshot }>(
        "/api/templates/native/install",
        command,
      ),
      theme = installed.current.themes[0]!,
      reference = { id: theme.id, version: theme.version, digest: theme.digest };
    const list = await request("/api/templates/native");
    expect(list.headers.get("cache-control")).toBe("no-store");
    const text = await list.text();
    expect(text).not.toContain("Owner-only original resource");
    expect(text).not.toContain('"descriptor"');
    expect(JSON.parse(text).themes[0].files).toBe(2);
    const detail = "/api/templates/native/detail?" + new URLSearchParams(reference);
    expect(await json(detail)).toMatchObject(reference);
    const content = "/api/templates/native/content?" + new URLSearchParams(reference);
    expect(await json<{ licenseText: string; readmeText: string }>(content)).toEqual({
      licenseText: "MIT fixture license",
      readmeText: "Native theme usage",
    });
    expect((await request(content + "&actor=forged")).status).toBe(400);
    const exportPath = "/api/templates/native/export?" + new URLSearchParams(reference),
      exported = await request(exportPath);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/zip");
    expect(exported.headers.get("cache-control")).toBe("private, no-store");
    expect(exported.headers.get("x-content-type-options")).toBe("nosniff");
    expect(exported.headers.get("content-disposition")).toContain("example.native-1.0.0.native-theme.zip");
    const exportedBytes = new Uint8Array(await exported.arrayBuffer()),
      exportedFiles = unzipSync(exportedBytes);
    expect(Object.keys(exportedFiles)).toEqual([
      "panda-native-theme.json",
      "theme/layout/index.ejs",
      "theme/source/logo.bin",
      "notices/LICENSE",
      "notices/README.md",
    ]);
    expect(exportedFiles["theme/source/logo.bin"]).toEqual(new Uint8Array([0, 10, 255]));
    expect(new TextDecoder().decode(exportedFiles["notices/LICENSE"])).toBe("MIT fixture license");
    expect((await fetch(app.base + exportPath)).status).toBe(401);
    expect((await request(exportPath + "&actor=forged")).status).toBe(400);
    expect((await request(exportPath + "&digest=duplicate")).status).toBe(400);
    const catalog = await json<{ templates: { reference: unknown; actions: unknown }[] }>(
      "/api/template-catalog?registry=native",
    );
    expect(catalog.templates).toHaveLength(1);
    expect(catalog.templates[0]!.reference).toMatchObject({ ...reference, registry: "native" });
    expect(catalog.templates[0]!.actions).toMatchObject({ preview: "site-build", export: "native-zip" });
    expect((await request(detail + "&actor=forged")).status).toBe(400);
    expect((await request(detail + "&id=duplicate")).status).toBe(400);
    expect((await request("/api/templates/native?actor=forged")).status).toBe(400);
    await json(
      "/api/templates/native/state",
      { reference, action: "disable", expectedRevision: installed.current.revision },
      "PUT",
    );
    await json("/api/package-sources/remove", { purpose: "templates", id: ready.id, revision: ready.revision });
    await app.stop();
    await app.start();
    const replay = await json<{ receipt: NativeThemeReceipt; current: NativeThemeSnapshot }>(
      "/api/templates/native/install",
      command,
    );
    expect(replay.receipt).toEqual(installed.receipt);
    expect(replay.current.themes[0]!.enabled).toBe(false);
    expect(await json(detail)).toMatchObject({ ...reference, enabled: false });
    const restartedExport = await request(exportPath);
    expect(restartedExport.status).toBe(200);
    expect(new Uint8Array(await restartedExport.arrayBuffer())).toEqual(exportedBytes);
  } finally {
    await app.dispose();
  }
}, 30000);
