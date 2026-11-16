import assert from "node:assert/strict";
import { waitFor } from "./app-fixture.mjs";

/** Exercise real editor identity, menu placement and document scrolling without replacing source HTML. */
export async function verifyDocumentToolbar({ page, api, project, base, width, out, label }) {
  const tree = await api("/api/project-document-tree?project=" + project.id),
    created = await api("/api/project-document-tree/documents", {
      id: crypto.randomUUID(),
      projectId: project.id,
      treeVersion: tree.version,
      title: "A long document keeps its position",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: Array.from({ length: 40 }, (_, n) => ({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `Paragraph ${n + 1}: Stable document scrolling preserves the editor and its content.`,
              },
            ],
          })),
        },
      },
    });
  await page.goto(base + "/documents?project=" + project.id + "&document=" + created.operation.documentId);
  await page.locator("#documentReadTitle").waitFor();
  await page.locator(width > 700 ? '[data-doc-action="edit"]' : '[data-authoring-action="reader-edit"]').click();
  const toolbar = page.locator(".document-rich-toolbar"),
    canvas = page.locator(".document-canvas"),
    slot = page.locator("#documentToolbarSlot"),
    surface = page.locator('.document-rich-content[contenteditable="true"]');
  await surface.waitFor();
  await waitFor(async () => await surface.evaluate((node) => node === document.activeElement));
  const original = await surface.elementHandle();
  await canvas.evaluate((node) => (node.scrollTop = 0));
  const start = await toolbar.boundingBox(),
    height = await canvas.evaluate((node) => node.scrollHeight);
  assert.ok(start);
  if (width > 700) {
    await waitFor(async () => (await slot.getAttribute("data-docked")) === "false");
    const title = await page.locator("#documentTitle").boundingBox();
    assert.ok(title && start.y + start.height <= title.y && Math.abs(start.x - title.x) < 2);
  }
  await canvas.evaluate((node) => (node.scrollTop = 600));
  await waitFor(async () => (await canvas.evaluate((node) => node.scrollTop)) >= 599);
  if (width > 700) await waitFor(async () => (await slot.getAttribute("data-docked")) === "true");
  const scrolled = await toolbar.boundingBox(),
    bounds = await canvas.boundingBox();
  assert.equal(await canvas.evaluate((node) => node.scrollHeight), height);
  assert.equal(await original.evaluate((node) => node === document.querySelector(".document-rich-content")), true);
  if (width > 700) {
    assert.ok(scrolled && bounds && Math.abs(scrolled.y - bounds.y - 8) < 2);
    await page.locator(".document-format-more>summary").click();
    const menu = page.locator(".document-format-more>div");
    await menu.waitFor();
    const box = await menu.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 900,
      `Toolbar menu must remain within the viewport: ${JSON.stringify({ width, box })}`,
    );
    await page.screenshot({ path: `${out}/${label}-toolbar-more-open.png` });
    await menu.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await menu.isVisible(), true, "Scrolling commands preserves the open menu");
    await canvas.evaluate((node) => (node.scrollTop = 500));
    await waitFor(async () => !(await menu.isVisible()));
  } else assert.ok(scrolled && Math.abs(scrolled.y - start.y) < 2 && scrolled.height === 56);
  await page.screenshot({ path: `${out}/${label}-toolbar-scrolled.png` });
  await canvas.evaluate((node) => (node.scrollTop = 0));
  if (width > 700) await waitFor(async () => (await slot.getAttribute("data-docked")) === "false");
  const returned = await toolbar.boundingBox();
  assert.ok(returned && Math.abs(returned.y - start.y) < 2);
  assert.equal(await canvas.evaluate((node) => node.scrollHeight), height);
  assert.equal(await surface.locator("p").count(), 40);
  await page.locator('[data-doc-action="preview"]').click();
  assert.equal(await slot.isVisible(), false);
  assert.equal(await page.locator(".document-toolbar-marker").isVisible(), false);
  await page.locator(width > 700 ? ".authoring-workspace-back" : ".authoring-project-back").click();
  await waitFor(async () => !(await original.evaluate((node) => node.isConnected)));
  assert.equal(await page.locator(".document-rich-toolbar").count(), 0);
}
