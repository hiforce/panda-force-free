import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const out = ".artifacts/knowledge-empty-rule",
  app = await createAppFixture({
    applicationKnowledge: true,
    extraEnvironment: ({ dir }) => {
      const path = join(dir, "knowledge-budget.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema: 1,
          enabled: true,
          id: "fixture",
          engineId: "codex",
          model: "gpt-fixture",
          generationBudget: { installationDaily: 2, ownerDaily: 1, installationPending: 2, ownerPending: 1 },
        }),
      );
      return { PANDA_FORCE_KNOWLEDGE_CONFIG_FILE: path };
    },
  });
await mkdir(out, { recursive: true });
const { chromium } = await import("playwright");
const browser = await chromium.launch(),
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en" });
try {
  await app.signIn(context);
  const api = async (path, data, method = data ? "POST" : "GET") => {
      const response = await context.request.fetch(app.base + path, { method, data });
      assert.ok(response.ok(), path + ": " + (await response.text()));
      return response.json();
    },
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  async function project(code) {
    const before = await api("/api/projects"),
      next = await api("/api/projects", { code, name: code, revision: before.revision });
    return next.projects.find((p) => p.code === code).id;
  }
  async function configure(id) {
    await page.goto(app.base + "/documents?" + new URLSearchParams({ project: id }));
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.locator(".document-workspace-more > summary").click();
    await page.locator('[data-authoring-action="knowledge"]').click();
    const panel = page.locator(".knowledge-panel[open]");
    await panel.locator('[data-knowledge-section="rules"]').click();
    const field = (name) => panel.locator('[name="pf-knowledge-rule-' + name + '"]');
    await waitFor(() => field("enabled").isEnabled());
    await field("enabled").check();
    await field("all").check();
    await field("purpose").fill("Explain future saved engineering decisions.");
    await panel.locator("[data-rule-preview]").click();
    await waitFor(() => panel.locator("[data-rule-apply]").isEnabled());
    assert.ok((await panel.locator("[data-rule-preview-notice]").innerText()).startsWith("0 "));
    await panel.locator("[data-rule-apply]").click();
    await waitFor(async () => (await api("/api/knowledge/generation-policy?project=" + id)).policy.enabled);
    assert.equal((await api("/api/project-document-tree?project=" + id)).nodes.length, 0);
    return panel;
  }
  async function save(id) {
    const tree = await api("/api/project-document-tree?project=" + id),
      created = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: id,
        treeVersion: tree.version,
        title: "First saved source",
        locale: "en",
        parentId: null,
      }),
      document = created.operation.documentId,
      query = new URLSearchParams({ project: id, id: document }),
      opened = await api("/api/project-documents/editor?" + query),
      draft = await api(
        "/api/project-documents/editor?" + query,
        {
          operationId: crypto.randomUUID(),
          version: opened.draft.version,
          baseRevisionId: opened.draft.baseRevisionId,
          working: {
            ...opened.working,
            body: {
              schema: 1,
              format: "richtext",
              document: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Save exact file versions before indexing knowledge." }],
                  },
                ],
              },
            },
          },
        },
        "PUT",
      );
    await api("/api/project-documents/checkpoints?" + query, {
      operationId: crypto.randomUUID(),
      revisionId: opened.saved.revision.id,
      draftVersion: draft.receipt.version,
    });
    return document;
  }
  const first = await project("empty-rule-first");
  let panel = await configure(first);
  await panel.locator("[data-knowledge-close]").click();
  await save(first);
  await waitFor(async () =>
    (await api("/api/knowledge/tasks?project=" + first)).tasks.some((t) => t.state === "review"),
  );
  const second = await project("empty-rule-second");
  panel = await configure(second);
  await save(second);
  await waitFor(
    async () => (await api("/api/knowledge/generation-status?project=" + second)).budget.blocked === "ownerDaily",
  );
  await panel.locator("[data-rule-status-refresh]").click();
  await waitFor(async () =>
    (await panel.locator("[data-rule-status]").innerText()).includes("Changing projects or rules does not reset usage"),
  );
  assert.equal((await api("/api/knowledge/tasks?project=" + second)).tasks.length, 0);
  const status = await api("/api/knowledge/generation-status?project=" + second);
  assert.equal(status.budget.ownerDailyUsed, 1);
  assert.equal(status.dailyUsed, 0);
  assert.equal("installationDailyUsed" in status.budget, false);
  await panel.locator("[data-rule-status]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/shared-budget-1440.png" });
  await page.setViewportSize({ width: 390, height: 960 });
  await panel.locator("[data-rule-status]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/shared-budget-390.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    "Empty project rule application initializes no documents; first saved source runs and another project cannot reset owner-wide usage.",
  );
} finally {
  await context.close();
  await browser.close();
  await app.dispose();
}
