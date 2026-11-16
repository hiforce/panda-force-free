import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const app = await createAppFixture();
await mkdir(".artifacts/document-code-blocks", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
      await app.signIn(context);
      await context.addInitScript(() => {
        globalThis.__copiedCode = null;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              globalThis.__copiedCode = text;
            },
          },
        });
      });
      const api = async (path, data, method = "get") => {
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects"),
        created = await api(
          "/api/projects",
          { code: "code-" + width, name: "Programming notes", revision: catalog.revision },
          "post",
        ),
        project = created.projects.find((value) => value.code === "code-" + width);
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-authoring-action="new"]:visible').first().click();
      const surface = page.locator('.document-rich-content[contenteditable="true"]');
      await surface.waitFor();
      await page.locator("#documentTitle").fill("Readable source code");
      const java =
        'public class Animal {\n  // A clear example\n  private String name = "Panda";\n  public int age = 3;\n  public String speak() { return name; }\n}\n';
      const assertJavaColors = async (block) => {
        for (const [token, variable] of [
          ["Animal", "--pf-code-type"],
          ["speak", "--pf-code-function"],
          ["3", "--pf-code-number"],
        ]) {
          const span = block
            .locator(".cm-content span")
            .filter({ hasText: new RegExp("^" + token + "$") })
            .first();
          await span.waitFor();
          assert.equal(
            await span.evaluate((node) => getComputedStyle(node).color),
            await page.evaluate((variable) => {
              const probe = document.createElement("span");
              probe.style.color = "var(" + variable + ")";
              document.body.append(probe);
              const color = getComputedStyle(probe).color;
              probe.remove();
              return color;
            }, variable),
            token + " must use its semantic highlight color",
          );
        }
      };
      await surface.evaluate((element, text) => {
        element.focus();
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", "~~~java\n" + text + "~~~");
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
        );
      }, java);
      const block = page.locator('.document-code-block[data-code-block-language="java"]');
      await block.waitFor();
      await block.hover();
      await block.locator(".cm-lineNumbers").waitFor();
      assert.ok((await block.locator(".cm-content span[class]").count()) > 0);
      await assertJavaColors(block);
      await block.locator(".cm-foldGutter [title]:visible").first().click();
      await block.locator(".cm-foldPlaceholder").waitFor();
      await block.locator("[data-code-copy]").click();
      assert.equal(await page.evaluate(() => globalThis.__copiedCode), java.trimEnd());
      await block.locator(".cm-foldPlaceholder").click();
      assert.equal(await block.locator(".cm-foldPlaceholder").count(), 0);
      await block.locator("[data-code-wrap]").click();
      assert.equal(await block.locator(".cm-lineWrapping").count(), 0);
      await block.locator("[data-code-wrap]").click();
      assert.equal(await block.locator(".cm-lineWrapping").count(), 1);
      await block.locator("[data-code-language]").click();
      const picker = page.locator(".document-code-language-menu");
      if (width < 700) {
        // Keep the simulated viewport separate from the shell's real viewport owner.
        await picker.evaluate((element) => {
          element.style.setProperty("--app-viewport-height", "400px");
          element.style.setProperty("--app-viewport-top", "80px");
        });
        const bounds = await picker.boundingBox();
        assert.ok(bounds.x >= 8 && bounds.width >= width - 32 && bounds.x + bounds.width <= width - 8);
        assert.ok(bounds.y >= 80 && bounds.y + bounds.height <= 480);
        assert.equal(await picker.isVisible(), true);
      }
      await picker.locator("input").fill("json");
      await picker.locator('[data-code-language-option="json"]').click();
      await page.locator('.document-code-block[data-code-block-language="json"]').waitFor();
      if (width < 700)
        await picker.evaluate((element) => {
          element.style.removeProperty("--app-viewport-height");
          element.style.removeProperty("--app-viewport-top");
        });
      await block.count();
      const current = page.locator(".document-code-block");
      await current.locator("[data-code-language]").click();
      assert.equal(await picker.locator('[data-code-language-option="json"]').getAttribute("aria-selected"), "true");
      await page.screenshot({ path: `.artifacts/document-code-blocks/languages-${width}.png` });
      await picker.locator("input").fill("java");
      await picker.locator('[data-code-language-option="java"]').click();
      await page.waitForTimeout(600);
      const code = current.locator('.cm-content[contenteditable="true"]');
      await code.click();
      await code.press("ControlOrMeta+End");
      await code.press("Enter");
      await code.pressSequentially("// More detail");
      const id = new URL(page.url()).searchParams.get("document"),
        scope = new URLSearchParams({ project: project.id, id });
      await waitFor(async () =>
        (await api("/api/project-documents/editor?" + scope)).working.body.document.content.some(
          (node) =>
            node.type === "codeBlock" && node.attrs.language === "java" && JSON.stringify(node).includes("More detail"),
        ),
      );
      await code.press("ControlOrMeta+z");
      await waitFor(
        async () =>
          !JSON.stringify((await api("/api/project-documents/editor?" + scope)).working.body).includes("More detail"),
      );
      // Physical Shift+Z emits an uppercase key value.
      await page.keyboard.press("ControlOrMeta+Shift+Z");
      await waitFor(async () =>
        JSON.stringify((await api("/api/project-documents/editor?" + scope)).working.body).includes("More detail"),
      );
      await page.locator('.document-file-commands [data-doc-action="save"]').click();
      await waitFor(async () => !(await api("/api/project-documents/editor?" + scope)).draft.dirty);
      const source = await api("/api/project-documents/source?" + scope);
      assert.match(source.revision.content, /```java/);
      assert.doesNotMatch(JSON.stringify(source.revision.body), /cm-|code-toolbar|lineNumbers/);
      await current.hover();
      await page.screenshot({ path: `.artifacts/document-code-blocks/editor-${width}.png` });
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('.document-code-block[data-code-block-language="java"]').waitFor();
      await page.locator(".document-code-block .cm-content span[class]").first().waitFor();
      await assertJavaColors(page.locator('.document-code-block[data-code-block-language="java"]'));
      for (const control of ["[data-code-copy]", "[data-code-wrap]"])
        assert.equal(await page.locator(control + " .icon-slot").isVisible(), true);
      assert.equal(await page.locator(".document-code-block [data-code-language]").isDisabled(), true);
      await page.locator(".document-code-block").hover();
      await page.locator("[data-code-copy]").click();
      assert.match(await page.evaluate(() => globalThis.__copiedCode), /More detail/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.artifacts/document-code-blocks/reader-${width}.png` });
      console.log(
        `${engine.name()} ${width}: fenced Java, actual highlighting, numbered lines, searchable language picker, wrapping, exact copy, nested edits/history and source/reload preservation passed`,
      );
    } catch (error) {
      if (page) await page.screenshot({ path: `.artifacts/document-code-blocks/failure-${width}.png` });
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
