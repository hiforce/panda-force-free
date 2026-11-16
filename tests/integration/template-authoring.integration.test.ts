import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createAppFixture } from "../support/app-fixture.mjs";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import type { TemplateDraftResult, TemplateDraftDetail } from "../../src/shared/templates/authoring/contracts.js";
import type { TemplateImage } from "../../src/shared/templates/authoring/images.js";
import type { PortableInstallResult, PortableTemplateReview } from "../../src/shared/templates/portable/registry.js";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";
import type { RichDocumentLayoutTemplate } from "../../src/shared/templates/types/contracts.js";

test("owned rich template HTTP workflows bind images, immutable releases and retry receipts across restart", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>();
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
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return response;
  }
  async function json<T>(path: string, body?: unknown, method?: string) {
    const response = await request(path, body, method);
    expect(response.status).toBeLessThan(400);
    return (await response.json()) as T;
  }
  const id = randomUUID(),
    command = {
      id,
      operationId: randomUUID(),
      expectedRevision: 0,
      templateType: "panda.document-template",
      definition: emptyDocumentTemplate("example.http-article"),
    };
  try {
    expect((await request("/api/template-drafts")).status).toBe(401);
    await json("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    await json("/api/auth/setup", { username: "fixture-owner" });
    expect((await request("/api/template-drafts", { ...command, owner: "forged" })).status).toBe(400);
    expect((await request("/api/template-drafts", command, "POST", { origin: "https://other.example" })).status).toBe(
      401,
    );
    const invalid = structuredClone(command);
    invalid.definition.body.document.content = [
      { type: "paragraph", content: [{ type: "heading", attrs: { level: 1 } }] },
    ];
    expect((await request("/api/template-drafts", invalid)).status).toBe(400);
    const created = await json<TemplateDraftResult>("/api/template-drafts", command);
    expect(created.current!.draft.revision).toBe(1);
    const bytes = await sharp({ create: { width: 9, height: 7, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    const imagesPath = "/api/template-drafts/images?" + new URLSearchParams({ draft: id });
    expect((await request(imagesPath + "&extra=1", bytes)).status).toBe(400);
    expect((await request(imagesPath, bytes, "POST", { origin: "https://other.example" })).status).toBe(401);
    expect(
      (await request(imagesPath, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status,
    ).toBe(400);
    expect((await request(imagesPath, bytes.subarray(0, 40))).status).toBe(400);
    const { image } = await json<{ image: TemplateImage }>(imagesPath, bytes);
    expect((await json<{ image: TemplateImage }>(imagesPath, bytes)).image).toEqual(image);
    expect((await json<TemplateDraftDetail>("/api/template-drafts/detail?id=" + id)).draft.revision).toBe(1);
    const imagePath = "/api/template-drafts/images/content?" + new URLSearchParams({ draft: id, id: image.id });
    const staged = await request(imagePath);
    expect(staged.headers.get("cache-control")).toBe("private, no-store");
    expect(staged.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await staged.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect((await fetch(app.base + imagePath)).status).toBe(401);
    expect(
      (
        await request(
          "/api/template-drafts/images/content?" + new URLSearchParams({ draft: randomUUID(), id: image.id }),
        )
      ).status,
    ).toBe(404);
    const definition = structuredClone(created.current!.definition);
    definition.images = [image];
    definition.instructions = "Keep sources and verify claims.";
    definition.body.document.content = [
      { type: "paragraph", content: [{ type: "text", text: "Reusable layout", marks: [{ type: "bold" }] }] },
      { type: "image", attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Owned illustration" } },
    ];
    const save = { id, operationId: randomUUID(), expectedRevision: 1, definition };
    const saved = await json<TemplateDraftResult>("/api/template-drafts", save, "PUT"),
      draft = saved.current!.draft;
    expect(draft.revision).toBe(2);
    expect((await request("/api/template-drafts", { ...save, operationId: randomUUID() }, "PUT")).status).toBe(409);
    const review = await json<PortableTemplateReview>("/api/template-drafts/review", {
      id,
      revision: 2,
      digest: draft.digest,
    });
    const release = {
      id,
      revision: 2,
      digest: draft.digest,
      approval: {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
    };
    const installed = await json<PortableInstallResult>("/api/template-drafts/publish", release);
    expect(installed.current.templates[0]!.origin).toMatchObject({ kind: "authoring", draftId: id, revision: 2 });
    const identity = new URLSearchParams({ id: definition.id, version: definition.version, digest: draft.digest });
    const preview = await json<{ model: RichDocumentLayoutTemplate }>("/api/templates/preview?" + identity);
    expect(preview.model.body.document.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }]);
    expect(preview.model.images).toEqual([image]);
    const nativeImagePath = "/api/templates/images/content?" + identity + "&image=" + image.id;
    const native = await request(nativeImagePath);
    expect(native.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(new Uint8Array(bytes));
    const exported = await json<unknown>("/api/templates/export?" + identity),
      verified = (await parsePortableTemplateBundle(new TextEncoder().encode(JSON.stringify(exported)))).templates[0]!;
    expect(verified.digest).toBe(draft.digest);
    expect(verified.read(image.path)).toEqual(new Uint8Array(bytes));
    expect(verified.text(verified.manifest.payload.path)).not.toContain("/api/document-assets");
    await json(
      "/api/template-drafts",
      {
        ...save,
        operationId: randomUUID(),
        expectedRevision: 2,
        definition: { ...definition, version: "1.0.1", instructions: "A later unpublished draft." },
      },
      "PUT",
    );
    await app.stop();
    await app.start();
    expect((await json<TemplateDraftResult>("/api/template-drafts", save, "PUT")).current!.draft.revision).toBe(3);
    expect((await json<PortableInstallResult>("/api/template-drafts/publish", release)).receipt).toEqual(
      installed.receipt,
    );
    expect((await request(imagePath)).status).toBe(200);
    const remove = { id, operationId: randomUUID(), expectedRevision: 3 };
    expect((await json<TemplateDraftResult>("/api/template-drafts", remove, "DELETE")).current).toBeNull();
    expect((await json<TemplateDraftResult>("/api/template-drafts", remove, "DELETE")).acknowledgement.removed).toBe(
      true,
    );
    expect((await request(imagePath)).status).toBe(404);
    expect((await request(nativeImagePath)).status).toBe(200);
    expect((await json<PortableInstallResult>("/api/template-drafts/publish", release)).receipt).toEqual(
      installed.receipt,
    );
  } finally {
    await app.dispose();
  }
}, 30000);
