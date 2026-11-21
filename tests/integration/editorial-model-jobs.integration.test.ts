import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

async function authenticatedHeaders(app: { base: string }) {
  const cookies = new Map<string, string>();
  const post = async (path: string, data: unknown) => {
    const response = await fetch(app.base + path, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: app.base, cookie: [...cookies.values()].join("; ") },
      body: JSON.stringify(data),
    });
    for (const value of response.headers.getSetCookie()) {
      const part = value.split(";")[0]!;
      cookies.set(part.split("=")[0]!, part);
    }
    expect(response.status).toBeLessThan(300);
    return response.json();
  };
  const login = await post("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
  if (login.migrationRequired) await post("/api/auth/setup", { username: "fixture-owner" });
  const headers = { cookie: [...cookies.values()].join("; "), Origin: app.base };
  const database = await (await fetch(app.base + "/api/system/database", { headers })).json();
  if (database.initialChoiceRequired) await post("/api/system/database/selection", { driver: "sqlite" });
  return headers;
}

test("configured model HTTP jobs preserve source review, recover after restart and fence cancellation without coding turns", async () => {
  const requests: Record<string, unknown>[] = [],
    authorizations: string[] = [];
  let mode = "success";
  const pending: { release: (() => void) | null } = { release: null };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      authorizations.push(req.headers.get("authorization") || "");
      const payload = await req.json();
      requests.push(payload);
      const current = mode;
      if (current === "hold")
        await new Promise<void>((resolve) => {
          pending.release = resolve;
          req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      if (current === "invalid")
        return Response.json({ status: "completed", output: [{ type: "function_call", name: "exec_command" }] });
      const supplied = JSON.parse(payload.input[0].content[0].text);
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  edits: supplied.segments.map((segment: { segmentId: string; text: string }) => ({
                    segmentId: segment.segmentId,
                    before: segment.text,
                    after: "This is a test.",
                    reason: "Agreement",
                  })),
                }),
              },
            ],
          },
        ],
      });
    },
  });
  const app = await createAppFixture({
    extraEnvironment: ({ dir }) => {
      const path = join(dir, "processing.json"),
        key = join(dir, "processing-key.txt");
      writeFileSync(key, "test-editorial-credential", { mode: 0o600 });
      writeFileSync(
        path,
        JSON.stringify({
          schema: 1,
          processors: [
            {
              id: "review",
              kind: "responses",
              model: "fixture-model",
              endpoint: `http://127.0.0.1:${provider.port}/responses`,
              apiKeyFile: key,
            },
          ],
        }),
      );
      return { PANDA_FORCE_EDITORIAL_CONFIG_FILE: path };
    },
  });
  const authHeaders = await authenticatedHeaders(app);
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...authHeaders, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/document-editorial/processors")).status).toBe(401);
    const profiles = (await call("/api/document-editorial/processors")).body.profiles;
    expect(profiles).toHaveLength(1);
    expect(JSON.stringify(profiles)).not.toContain("credential");
    expect(JSON.stringify(profiles)).not.toContain("127.0.0.1");
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "model-jobs", name: "Model tasks", revision: catalog.revision })
    ).body.projects.find((entry: { code: string }) => entry.code === "model-jobs");
    const source = (
      await call("/api/project-documents", "POST", { projectId: project.id, title: "Original", locale: "en" })
    ).body;
    const saved = (
      await call("/api/documents/detail?id=" + source.document.id, "PUT", {
        revision: 1,
        title: "Original",
        locale: "en",
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "This are a test.", marks: [{ type: "bold" }] }] },
              {
                type: "blockquote",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Protected quote." }] }],
              },
            ],
          },
        },
      })
    ).body;
    const input = {
      id: randomUUID(),
      documentId: saved.document.id,
      revisionId: saved.revision.id,
      mode: "proofread",
      profileId: "review",
    };
    expect([401, 403]).toContain(
      (await call("/api/document-editorial/jobs", "POST", input, { origin: "https://untrusted.example" })).status,
    );
    expect(
      (await call("/api/document-editorial/jobs", "POST", { ...input, endpoint: "https://untrusted.example" })).status,
    ).toBe(400);
    mode = "hold";
    expect((await call("/api/document-editorial/jobs", "POST", input)).status).toBe(202);
    await waitFor(() => requests.length === 1);
    await app.stop();
    pending.release?.();
    mode = "success";
    await app.start();
    await waitFor(
      async () => (await call("/api/document-editorial/jobs/detail?id=" + input.id)).body.job.state === "succeeded",
    );
    const done = (await call("/api/document-editorial/jobs/detail?id=" + input.id)).body.job;
    expect(done.attempts).toBe(2);
    expect((await call("/api/document-editorial/jobs", "POST", input)).body.job).toEqual(done);
    expect((await call("/api/documents/detail?id=" + saved.document.id)).body).toEqual(saved);
    const review = (await call("/api/document-editorial/detail?id=" + done.proposalId)).body;
    expect(review.proposal.producer.model).toBe("fixture-model");
    expect(review.proposal.edits).toHaveLength(1);
    expect(review.receipt).toBeNull();
    expect(JSON.stringify(requests)).not.toContain("Protected quote");
    expect(requests[0]!.tools).toEqual([]);
    expect(requests[0]!.tool_choice).toBe("none");
    expect(authorizations.every((value) => value === "Bearer test-editorial-credential")).toBe(true);
    mode = "hold";
    const cancelled = { ...input, id: randomUUID() };
    writeFileSync(join(app.dir, "processing-key.txt"), "rotated-editorial-credential", { mode: 0o600 });
    const count = requests.length;
    await call("/api/document-editorial/jobs", "POST", cancelled);
    await waitFor(() => requests.length > count);
    expect(authorizations.at(-1)).toBe("Bearer rotated-editorial-credential");
    expect(
      (await call("/api/document-editorial/jobs/action", "POST", { id: cancelled.id, action: "cancel" })).body.job
        .state,
    ).toBe("cancelled");
    pending.release?.();
    await Bun.sleep(50);
    expect((await call("/api/document-editorial/jobs/detail?id=" + cancelled.id)).body.job.proposalId).toBeNull();
    mode = "invalid";
    const retryId = randomUUID();
    await call("/api/document-editorial/jobs/action", "POST", { id: cancelled.id, action: "retry", retryId });
    await waitFor(
      async () => (await call("/api/document-editorial/jobs/detail?id=" + cancelled.id)).body.job.state === "failed",
    );
    expect((await call("/api/document-editorial/jobs/detail?id=" + cancelled.id)).body.job.failure).toBe(
      "invalidOutput",
    );
    expect(
      (await call("/api/document-editorial/jobs/action", "POST", { id: cancelled.id, action: "retry", retryId })).body
        .job.state,
    ).toBe("failed");
    expect((await call("/api/documents/detail?id=" + saved.document.id)).body).toEqual(saved);
    expect(app.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    pending.release?.();
    await app.dispose();
    provider.stop(true);
  }
}, 30000);

test("invalid optional processing configuration does not prevent writing or local spacing review", async () => {
  const app = await createAppFixture({
    extraEnvironment: ({ dir }) => {
      const path = join(dir, "broken-processing.json");
      writeFileSync(path, "{invalid private-fixture-setting");
      return { PANDA_FORCE_EDITORIAL_CONFIG_FILE: path };
    },
  });
  const authHeaders = await authenticatedHeaders(app);
  const call = async (path: string, method = "GET", data?: unknown) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(data), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...authHeaders, "content-type": "application/json" },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
    expect(response.status).toBeLessThan(300);
    return response.json();
  };
  try {
    const settings = await call("/api/document-editorial/processors");
    expect(settings).toEqual({ profiles: [], configurationInvalid: true, runtimeSelection: true });
    expect(JSON.stringify(settings)).not.toContain("private-fixture-setting");
    const catalog = await call("/api/projects"),
      created = await call("/api/projects", "POST", {
        code: "local-review",
        name: "Writing remains available",
        revision: catalog.revision,
      }),
      project = created.projects.find((entry: { code: string }) => entry.code === "local-review");
    const source = await call("/api/project-documents", "POST", {
      projectId: project.id,
      title: "Original",
      locale: "en",
    });
    const saved = await call("/api/documents/detail?id=" + source.document.id, "PUT", {
      revision: 1,
      title: "Original",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Words  spaced." }] }],
        },
      },
    });
    const review = await call("/api/document-editorial", "POST", {
      id: randomUUID(),
      documentId: saved.document.id,
      revisionId: saved.revision.id,
      mode: "spacing",
    });
    expect(review.proposal.edits).toHaveLength(1);
    expect(review.proposal.producer.kind).toBe("rules");
  } finally {
    await app.dispose();
  }
}, 30000);
