import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";
import { portableFixture, fixtureBytes } from "../support/portable-templates.js";
import type { PortableInstallResult, PortableTemplateReview } from "../../src/shared/templates/portable/registry.js";
import type { TemplateCatalogPage } from "../../src/shared/templates/catalog.js";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";

test("portable mixed templates use authenticated management routes, retain provenance and survive restart without granting execution", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>();
  async function call<T = { code: string }>(
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
  const content = new TextDecoder().decode(fixtureBytes(await portableFixture())),
    input = {
      content,
      name: "mixed.templates.json",
      selected: ["example.article-outline@1.0.0", "example.brand-slides@1.0.0"],
    };
  try {
    expect((await call("/api/templates/review", input)).status).toBe(401);
    await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    await call("/api/auth/setup", { username: "fixture-owner" });
    const skillsBefore = (await call<unknown>("/api/skill-packs")).body;
    expect((await call("/api/templates/review", { ...input, origin: { kind: "builtin" } })).status).toBe(400);
    expect((await call("/api/templates/review", { ...input, name: "../private.json" })).status).toBe(400);
    const { body: review, status } = await call<PortableTemplateReview>("/api/templates/review", input);
    expect(status).toBe(200);
    expect(review.source.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(review.candidates).toHaveLength(3);
    const request = {
      content,
      name: input.name,
      approval: {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
    };
    expect((await call("/api/templates/install", request, "POST", "https://other.example")).status).toBe(401);
    const installed = await call<PortableInstallResult>("/api/templates/install", request);
    expect(installed.status).toBe(201);
    expect(installed.body.current.templates).toHaveLength(2);
    expect((await call<PortableInstallResult>("/api/templates/install", request)).body.receipt).toEqual(
      installed.body.receipt,
    );
    const article = installed.body.current.templates.find((item) => item.id === "example.article-outline")!;
    const identity = new URLSearchParams({ id: article.id, version: article.version, digest: article.digest });
    const page = (await call<TemplateCatalogPage>("/api/template-catalog?type=panda.document-template")).body;
    expect(page.templates.find((item) => item.reference.registry === "portable")).toMatchObject({
      state: { enabled: true },
      compatibility: { engines: [], outputs: [], formats: [] },
      actions: { editor: "portable-document", preview: "portable-template", export: "portable-template" },
    });
    expect(JSON.stringify(page)).not.toContain("contentSlots");
    const exported = await call<unknown>("/api/templates/export?" + identity);
    expect(
      (await parsePortableTemplateBundle(new TextEncoder().encode(JSON.stringify(exported.body)))).templates[0]!.digest,
    ).toBe(article.digest);
    const preview = await call<{ model: { kind: string; content: string } }>("/api/templates/preview?" + identity);
    expect(preview.body.model.kind).toBe("document");
    expect(preview.body.model.content).toContain("## Evidence\n");
    expect((await call("/api/templates/detail?" + identity + "&extra=1")).status).toBe(400);
    const state = {
      id: article.id,
      version: article.version,
      digest: article.digest,
      action: "disable",
      expectedRevision: installed.body.current.revision,
    };
    expect((await call("/api/templates/state", state, "PUT")).status).toBe(200);
    await app.stop();
    await app.start();
    const replay = await call<PortableInstallResult>("/api/templates/install", request);
    expect(replay.body.current.templates.find((item) => item.id === article.id)!.enabled).toBe(false);
    expect(replay.body.receipt).toEqual(installed.body.receipt);
    expect((await call("/api/templates/state", { ...state, action: "enable" }, "PUT")).status).toBe(409);
    const disabled = (await call<TemplateCatalogPage>("/api/template-catalog?state=disabled")).body;
    expect(disabled.templates.some((item) => item.reference.registry === "portable")).toBe(true);
    expect((await call<unknown>("/api/skill-packs")).body).toEqual(skillsBefore);
  } finally {
    await app.dispose();
  }
}, 30000);
