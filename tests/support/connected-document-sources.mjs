/** Publishing suites explicitly enter the secondary source manager; project writing stays the default. */
export async function openConnectedDocumentSources(page) {
  if (new URL(page.url()).pathname !== "/documents") return;
  await page
    .locator('[data-authoring-action="sources"], [data-doc-action="new-space"]')
    .first()
    .waitFor({ state: "attached" });
  const button = page.locator('[data-authoring-action="sources"]');
  if (!(await button.count())) return;
  const menu = page.locator(".document-workspace-more summary");
  if (!(await menu.isVisible())) {
    await page
      .locator('[data-authoring-action="reader-directory"]:visible, [data-authoring-action="directory"]:visible')
      .first()
      .click();
  }
  await menu.click();
  await button.click();
  await page.locator('[data-doc-action="new-space"]').waitFor();
}
