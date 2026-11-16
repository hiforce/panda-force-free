import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";
import { strFromU8, unzipSync } from "fflate";

test("publication preparation is authenticated, revision-bound and durable without external publication", async () => {
  const fixture = await createAppFixture();
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.legacyProject(body), { status: 201 })
        : await fetch(fixture.base + path, {
            method,
            headers: { ...fixture.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(fixture.base + "/api/publication-variants?document=unknown")).status).toBe(401);
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "writing", name: "Writing", revision: catalog.revision })
    ).body.projects[0];
    const space = (
      await call("/api/document-spaces", "POST", {
        projectId: project.id,
        name: "Writing",
        code: "writing",
        engine: "markdown",
        sourceMode: "managed",
        locale: "en",
      })
    ).body.space;
    const detail = (
      await call("/api/documents", "POST", {
        spaceId: space.id,
        path: "article.md",
        title: "A test",
        locale: "en",
        content: "Two  spaces.\n\nA stable reference.",
      })
    ).body;
    const input = {
      documentId: detail.document.id,
      revisionId: detail.revision.id,
      format: "html",
      mode: "format",
      templateId: "minimal",
    };
    expect([401, 403]).toContain(
      (await call("/api/publication-variants", "POST", input, { origin: "https://untrusted.example" })).status,
    );
    expect((await call("/api/publication-variants", "POST", { ...input, mode: "rewrite" })).body.messageId).toBe(
      "publishing.unsupportedMode",
    );
    expect((await call("/api/publication-variants", "POST", { ...input, format: "not-a-platform" })).status).toBe(400);
    const result = await call("/api/publication-variants", "POST", input);
    expect(result.status).toBe(201);
    const prepared = result.body;
    expect(prepared.review).toBeNull();
    expect(prepared.variant.text).toContain("Two  spaces.");
    const reviewed = (
      await call("/api/publication-variants/review", "POST", {
        id: prepared.variant.id,
        digest: prepared.digest,
        acceptedIssues: [],
      })
    ).body;
    expect(reviewed.review.digest).toBe(prepared.digest);
    const suggestions = (
      await call(`/api/publication-proofread?document=${detail.document.id}&revision=${detail.revision.id}`)
    ).body.suggestions;
    const proposal = (
      await call("/api/publication-proofread", "POST", {
        documentId: detail.document.id,
        revisionId: detail.revision.id,
        selected: suggestions.map((s: { id: string }) => s.id),
      })
    ).body;
    expect(proposal.content).toContain("Two spaces.");
    expect((await call("/api/documents/detail?id=" + detail.document.id)).body.revision.content).toContain(
      "Two  spaces.",
    );
    await fixture.stop();
    await fixture.start();
    const restored = (await call("/api/publication-variants/detail?id=" + prepared.variant.id)).body;
    expect(restored.variant).toEqual(prepared.variant);
    expect(restored.digest).toBe(prepared.digest);
    expect(restored.review).toEqual(reviewed.review);
    const download = await fetch(
      fixture.base + `/api/publication-variants/export?id=${prepared.variant.id}&kind=html`,
      { headers: fixture.headers },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toContain("Two  spaces.");
    await call("/api/documents/detail?id=" + detail.document.id, "PUT", {
      revision: 1,
      title: "Updated",
      locale: "en",
      content: "Updated content",
    });
    expect((await call("/api/publication-variants/detail?id=" + prepared.variant.id)).body.stale).toBe(true);
    expect(
      (
        await call("/api/publication-variants/review", "POST", {
          id: prepared.variant.id,
          digest: prepared.digest,
          acceptedIssues: [],
        })
      ).status,
    ).toBe(409);
    expect((await call("/api/publication-variants", "POST", input)).status).toBe(409);
    const original = await call("/api/project-documents", "POST", {
      projectId: project.id,
      title: "Rich original",
      locale: "en",
    });
    expect(original.status).toBe(201);
    const rich = await call("/api/documents/detail?id=" + original.body.document.id, "PUT", {
      revision: 1,
      title: "Rich original",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { textAlign: "center" },
              content: [{ type: "text", text: "Keep this format", marks: [{ type: "underline" }] }],
            },
          ],
        },
      },
    });
    expect(rich.status).toBe(200);
    const richInput = { ...input, documentId: rich.body.document.id, revisionId: rich.body.revision.id };
    const richHtml = await call("/api/publication-variants", "POST", richInput);
    expect(richHtml.status).toBe(201);
    expect(richHtml.body.variant.source.sourceHash).toBe(rich.body.revision.contentHash);
    expect(richHtml.body.variant.html).toContain("<u>Keep this format</u>");
    expect(richHtml.body.variant.issues).toEqual([]);
    const richArticle = await call("/api/publication-variants", "POST", { ...richInput, format: "x-article" });
    expect(richArticle.status).toBe(201);
    expect(richArticle.body.variant.issues.some((issue: { code: string }) => issue.code === "unsupportedStyle")).toBe(
      true,
    );
    expect(
      (
        await call("/api/publication-variants/review", "POST", {
          id: richArticle.body.variant.id,
          digest: richArticle.body.digest,
          acceptedIssues: [],
        })
      ).status,
    ).toBe(409);
    const guarded = await call("/api/publication-proofread", "POST", {
      documentId: richInput.documentId,
      revisionId: richInput.revisionId,
      selected: [],
    });
    expect(guarded.status).toBe(400);
    expect(guarded.body.messageId).toBe("publishing.unsupportedMode");
    expect((await call("/api/documents/detail?id=" + richInput.documentId)).body.revision).toEqual(rich.body.revision);
    await fixture.stop();
    await fixture.start();
    const richDownload = await fetch(
      fixture.base + `/api/publication-variants/export?id=${richHtml.body.variant.id}&kind=bundle`,
      { headers: fixture.headers },
    );
    expect(richDownload.status).toBe(200);
    const files = unzipSync(new Uint8Array(await richDownload.arrayBuffer()));
    expect(JSON.parse(strFromU8(files["source.rich.json"]!))).toEqual(rich.body.revision.body);
    expect(strFromU8(files["article.html"]!)).toContain("<u>Keep this format</u>");
    expect(fixture.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
