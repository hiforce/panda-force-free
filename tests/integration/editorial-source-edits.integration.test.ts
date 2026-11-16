import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";

test("editorial HTTP protects source review, survives retries/restart and never authorizes publication", async () => {
  const app = await createAppFixture();
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...app.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/document-editorial?document=missing")).status).toBe(401);
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "editorial", name: "Editorial", revision: catalog.revision })
    ).body.projects[0];
    const source = (
      await call("/api/project-documents", "POST", { projectId: project.id, title: "Original", locale: "en" })
    ).body;
    const body = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { textAlign: "center" },
            content: [{ type: "text", text: "Words  with spaces.  ", marks: [{ type: "underline" }] }],
          },
        ],
      },
    };
    const saved = (
      await call("/api/documents/detail?id=" + source.document.id, "PUT", {
        revision: 1,
        title: "Original",
        locale: "en",
        body,
      })
    ).body;
    const input = { id: randomUUID(), documentId: saved.document.id, revisionId: saved.revision.id, mode: "spacing" };
    expect([401, 403]).toContain(
      (await call("/api/document-editorial", "POST", input, { origin: "https://untrusted.example" })).status,
    );
    const prepared = await call("/api/document-editorial", "POST", input);
    expect(prepared.status).toBe(201);
    expect(prepared.body.proposal.source.sourceHash).toBe(saved.revision.contentHash);
    expect((await call("/api/document-editorial", "POST", input)).body).toEqual(prepared.body);
    expect(prepared.body.proposal.edits).toHaveLength(2);
    const history = await call("/api/document-editorial/history?document=" + saved.document.id);
    expect(history.body.reviews.map((item: { id: string }) => item.id)).toEqual([input.id]);
    expect(history.body.reviews[0].applied).toBe(false);
    expect(JSON.stringify(history.body)).not.toContain('"edits"');
    expect(
      (await call("/api/document-editorial/history?document=" + saved.document.id + "&before=invalid!")).status,
    ).toBe(400);
    const accept = { id: input.id, digest: prepared.body.digest, selected: [prepared.body.proposal.edits[0].id] };
    expect((await call("/api/document-editorial/accept", "POST", { ...accept, digest: "forged" })).status).toBe(409);
    expect((await call("/api/document-editorial/accept", "POST", { ...accept, selected: ["forged"] })).status).toBe(
      400,
    );
    const accepted = await call("/api/document-editorial/accept", "POST", accept);
    expect(accepted.status).toBe(200);
    expect((await call("/api/document-editorial/history?document=" + saved.document.id)).body.reviews[0].applied).toBe(
      true,
    );
    const current = (await call("/api/documents/detail?id=" + source.document.id)).body;
    expect(current.document.revision).toBe(3);
    expect(current.revision.body.document.content[0].content[0].text).toBe("Words with spaces.  ");
    expect(current.revision.body.document.content[0].content[0].marks).toEqual([{ type: "underline" }]);
    await app.stop();
    await app.start();
    expect((await call("/api/document-editorial/accept", "POST", accept)).body).toEqual(accepted.body);
    expect((await call("/api/documents/detail?id=" + source.document.id)).body.document.revision).toBe(3);
    expect((await call("/api/document-editorial/detail?id=" + input.id)).body.receipt).toEqual(accepted.body.receipt);
    const latest = { ...input, id: randomUUID(), revisionId: current.revision.id };
    const next = (await call("/api/document-editorial", "POST", latest)).body;
    body.document.content[0]!.attrs.textAlign = "right";
    body.document.content[0]!.content[0]!.text = "Words with spaces.  ";
    await call("/api/documents/detail?id=" + source.document.id, "PUT", {
      revision: 3,
      title: "Original",
      locale: "en",
      body,
    });
    expect(
      (
        await call("/api/document-editorial/accept", "POST", {
          id: next.proposal.id,
          digest: next.digest,
          selected: next.proposal.edits.map((edit: { id: string }) => edit.id),
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/api/document-editorial", "POST", { ...latest, id: randomUUID(), mode: "proofread" })).body
        .messageId,
    ).toBe("editorial.unsupportedMode");
    expect(app.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    await app.dispose();
  }
}, 30000);
