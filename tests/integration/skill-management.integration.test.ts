import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import type { SkillInstallReview, SkillPackDetail } from "../../src/shared/skills/registry.js";
import type { TemplateCatalogPage } from "../../src/shared/templates/catalog.js";
import { decodeSkillBundle } from "../../src/server/skills/storage/codec.js";

test("native template uploads bind real provenance and selected authority; inspection, lifecycle and export survive restart", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>();
  async function call<T = { code: string }>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    origin?: string,
  ) {
    const res = await fetch(app.base + path, {
      method,
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return { status: res.status, body: (await res.json()) as T };
  }
  const { pack, content } = await nativeSkillPackage();
  const upload = { content, name: "writing.skill.json", selected: ["blog-outline"] };
  try {
    expect((await call("/api/skill-packs/review", upload)).status).toBe(401);
    await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    await call("/api/auth/setup", { username: "fixture-owner" });
    expect((await call("/api/skill-packs/review", { ...upload, origin: { kind: "builtin" } })).status).toBe(400);
    expect((await call("/api/skill-packs/review", { ...upload, content: "{}" })).status).toBe(400);
    expect((await call("/api/skill-packs/review", { ...upload, name: "../private.json" })).status).toBe(400);
    const reviewed = await call<SkillInstallReview>("/api/skill-packs/review", upload);
    expect(reviewed.status).toBe(200);
    const review = reviewed.body;
    expect(review.capabilities).toEqual([]);
    expect(review.origin).toEqual({
      kind: "upload",
      name: upload.name,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    const approval = {
      id: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      capabilities: review.capabilities,
      selected: review.selected,
    };
    const request = { content, name: upload.name, approval };
    expect((await call("/api/skill-packs/install", request, "POST", "https://other.example")).status).toBe(401);
    expect(
      (await call("/api/skill-packs/install", { ...request, approval: { ...approval, selected: ["writing"] } })).status,
    ).toBe(409);
    const installed = await call<SkillPackDetail>("/api/skill-packs/install", request);
    expect(installed.status).toBe(201);
    expect(installed.body.package?.exports.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual([
      "blog-outline",
    ]);
    expect((await call<SkillPackDetail>("/api/skill-packs/install", request)).body.revision).toBe(
      installed.body.revision,
    );
    const identity = new URLSearchParams({ id: pack.manifest.id, version: pack.manifest.version });
    const state = installed.body;
    const command = {
      operationId: randomUUID(),
      id: pack.manifest.id,
      version: pack.manifest.version,
      expectedRevision: state.revision,
      exports: state.package!.exports.map((entry) => ({ id: entry.id, enabled: true })),
    };
    expect((await call("/api/skill-packs/exports", command, "PUT")).status).toBe(403);
    command.exports = state.package!.exports.map((entry) => ({ id: entry.id, enabled: false }));
    expect((await call("/api/skill-packs/exports", command, "PUT")).status).toBe(200);
    const source = await call<{ kind: string; content: string }>(
      "/api/skill-packs/template?" + identity + "&exportId=blog-outline",
    );
    expect(source.body.kind).toBe("structure");
    expect(source.body.content).toContain("## Approach and examples");
    expect((await call("/api/skill-packs/template?" + identity + "&exportId=..%2Fprivate")).status).toBe(400);
    const exported = await call<unknown>("/api/skill-packs/export?" + identity);
    expect((await decodeSkillBundle(new TextEncoder().encode(JSON.stringify(exported.body)))).digest).toBe(pack.digest);
    await app.stop();
    await app.start();
    const saved = (await call<SkillPackDetail>("/api/skill-packs/detail?" + identity)).body;
    expect(saved.package?.digest).toBe(pack.digest);
    expect(saved.package?.exports.every((entry) => !entry.enabled)).toBe(true);
    expect((await call("/api/skill-packs/exports", { ...command, operationId: randomUUID() }, "PUT")).status).toBe(409);
    const page = (await call<TemplateCatalogPage>("/api/template-catalog?type=panda.document-template&state=disabled"))
      .body;
    expect(page.templates[0]?.actions.preview).toBe("skill-template");
    expect(page.templates[0]?.state.enabled).toBe(false);
    expect(JSON.stringify(page)).not.toContain("instructions.md");
  } finally {
    await app.dispose();
  }
}, 30000);
