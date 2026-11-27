import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createEncryptionKey } from "../../src/client/encryption-keys/key-store.ts";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.ts";
import { prepareMemoryMaterials } from "../../src/server/project-memory/pmf-materials.ts";
import { memoryPackageRecipient } from "../../src/server/project-memory/pmf.ts";
import { createMemoryArchive } from "../../src/server/project-memory/portability.ts";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { materialPdf } from "../support/material-text.ts";
import { memoryImageTextFixture, recognizedImageText } from "../support/memory-image-text.ts";

const proof = process.env.PANDA_FORCE_MEMORY_READER_PROOF || ".artifacts/project-memory-reader";
await mkdir(proof, { recursive: true });
const phrase = "test only memory reader key";
const backup = await createEncryptionKey("Reading fixture", phrase);
const image = await sharp("public/assets/skill-cover-information-architecture-v1.webp")
  .resize(760, 440)
  .png()
  .toBuffer();
const slides = await renderCreationSlides(
  [
    { layout: "content", title: "Overview", body: "First review." },
    {
      layout: "picture",
      title: "Site access",
      body: "Inspect the ramp. Use Meridian coating.",
      imageHandle: "1".repeat(64),
    },
  ],
  async () => image,
);
const square = (color) => {
  const drawing = color + " rg 50 280 420 400 re f";
  return "<< /Length " + drawing.length + " >>\nstream\n" + drawing + "\nendstream";
};
const pdf = materialPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
  square("0.8 0 0"),
  square("0 0.52 0.64"),
]);
const projectMemory = createMemoryArchive(
  [
    { key: "accessibility", scope: "site", values: ["Keep the ramp entrance visible"] },
    { key: "facade", scope: "materials", values: ["Use the approved palette"] },
  ],
  Date.now(),
);
const files = new Map();
const material = (id, title, kind, name, bytes, location, key = "accessibility", scope = "site") => {
  const digest = createHash("sha256").update(bytes).digest("hex");
  files.set(digest, bytes);
  return {
    id,
    version: "saved",
    title,
    kind,
    files: [{ name, digest, size: bytes.length }],
    anchors: [{ key, scope, location }],
  };
};
const materials = [
  material("overview", "Site review", "slides", "Site review.pptx", slides.bytes, { kind: "slide", number: 2 }),
  material("standards", "Site standards", "file", "Site standards.pdf", pdf, { kind: "page", number: 2 }),
  material("plan", "Entry plan", "image", "Entry plan.png", image, {
    kind: "image",
    x: 0.2,
    y: 0.2,
    width: 0.4,
    height: 0.35,
  }),
  material(
    "notes",
    "Site notes",
    "document",
    "Site notes.md",
    Buffer.from(
      "# Site notes\n\nReview the entrance.\n\n**Keep the ramp entrance visible.**\n<script>alert(1)</script>\n",
    ),
    { kind: "paragraph", number: 2 },
  ),
  material(
    "palette",
    "Color samples",
    "file",
    "Facade palette.txt",
    Buffer.from("Charcoal and light gray."),
    { kind: "paragraph", number: 800 },
    "facade",
    "materials",
  ),
];
const withOcr = process.env.PANDA_FORCE_TEST_MEMORY_OCR === "1";
if (withOcr) {
  const bytes = await memoryImageTextFixture();
  const hash = createHash("sha256").update(bytes).digest("hex");
  files.set(hash, bytes);
  materials.push({
    id: "drawing-sheet",
    title: "Drawing sheet",
    kind: "image",
    locale: "en",
    version: "saved",
    files: [{ name: "drawing-sheet.png", size: bytes.length, digest: hash }],
  });
}
const writer = prepareMemoryMaterials({ version: 2, memory: projectMemory, materials }, async function* (digest) {
  yield files.get(digest);
});
const parts = [];
for await (const chunk of writer(memoryPackageRecipient(backup.publicKey))) parts.push(chunk);
const archive = Buffer.concat(parts);

const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  extraEnvironment({ dir }) {
    const profiles = ["visual", "text"].map((mode) => {
      const accountHome = join(dir, "memory-grok-" + mode);
      mkdirSync(accountHome, { recursive: true });
      writeFileSync(
        join(accountHome, "auth.json"),
        JSON.stringify({
          fixture: { access_token: "fixture-only", visualInput: mode === "visual", captureMemoryPrompt: true },
        }),
      );
      return {
        id: "grok-" + mode,
        name: "Grok fixture " + mode,
        accountHome,
        command: resolve("tests/support/grok-acp-fixture.mjs"),
      };
    });
    return { PANDA_FORCE_HARNESS_PROFILES: JSON.stringify(profiles) };
  },
});
const recallLabels = {
  en: "Visual evidence sent",
  "zh-CN": "已发送图像证据",
  "zh-HK": "已傳送圖像證據",
  "zh-TW": "已傳送影像證據",
};
const recognitionLabels = {
  en: "Text recognized from image",
  "zh-CN": "图中文字",
  "zh-HK": "圖片辨識文字",
  "zh-TW": "影像辨識文字",
};
const nativeHomes = join(app.dir, "panda-state", "harness", "native");
async function capturedAcpPrompt(question) {
  for (const home of await readdir(nativeHomes)) {
    const prompt = await readFile(join(nativeHomes, home, "memory-prompt.json"), "utf8")
      .then(JSON.parse)
      .catch(() => []);
    if (prompt.some((part) => part.type === "text" && part.text.endsWith(question))) return prompt;
  }
  throw Error("The isolated ACP transport did not dispatch the request");
}
try {
  for (const [type, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1180, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 840 },
        locale,
        isMobile: width < 700,
        hasTouch: width < 700,
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (window !== top || !/^https?:$/.test(location.protocol)) return;
        localStorage.setItem("panda-force-locale", locale);
        localStorage.setItem("panda-force-theme", "aurora");
      }, locale);
      const api = async (path, data) => {
        const response = await context.request.fetch(app.base + path, {
          method: data === undefined ? "GET" : "POST",
          headers: { Origin: app.base },
          data,
        });
        assert.ok(response.ok(), path + " " + response.status() + " " + (response.ok() ? "" : await response.text()));
        return response.json();
      };
      const revision = (await api("/api/projects")).revision;
      const code = "materials-" + locale.toLowerCase();
      const created = await api("/api/projects", { name: "Architecture", code, revision, operationId: randomUUID() });
      const project = created.projects.find((row) => row.code === code);
      const path = "/api/projects/" + project.id + "/";
      const page = await context.newPage();
      await page.goto(
        app.base + "/project?" + new URLSearchParams({ id: project.id, tab: "memory", memoryView: "records" }),
      );
      await page.waitForFunction((language) => document.documentElement.lang === language, locale);
      await page.evaluate((value) => {
        localStorage.setItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey, JSON.stringify([value]));
      }, backup);
      const imports = page.locator("[data-memory-packages-import]");
      await imports.click();
      const dialog = page.locator(".memory-package-dialog");
      await dialog
        .locator("[data-memory-package-file]")
        .setInputFiles({ name: "examples.pmf", mimeType: "application/vnd.pandaforce.memory", buffer: archive });
      await dialog.locator("[data-memory-package-unlock] input").fill(phrase);
      await dialog.locator("[data-memory-package-review]").click();
      const commit = dialog.locator('button[type="submit"]');
      await commit.click();
      await dialog.locator("[data-package-withdraw]").waitFor();
      const historyImage = dialog.locator("[data-memory-package-history] button").filter({ hasText: "Entry plan.png" });
      await historyImage.click();
      const reader = dialog.locator(".memory-material-reader");
      await reader.locator("img").waitFor();
      await reader.locator("img").evaluate((element) => element.decode());
      await reader.locator("[data-memory-material-back]").click();
      assert(await historyImage.evaluate((element) => element === document.activeElement));
      await dialog.locator("[data-memory-package-close]").click();

      const searchTerm = "Meridian coating";
      const query = path + "memory?" + new URLSearchParams({ q: searchTerm });
      await waitFor(async () => {
        const materials = (await api(query)).materials;
        return materials?.state === "ready" && materials.hits.some((hit) => hit.file.name === "Site review.pptx");
      }, 60000);
      const search = page.locator("[data-memory-search]");
      await search.locator("input").fill(searchTerm);
      await search.locator("button").click();
      const resultList = page.locator("[data-memory-materials]");
      const result = resultList.getByRole("button", { name: "Site review", exact: true });
      await result.waitFor();
      assert.match(await resultList.textContent(), /Meridian coating/);
      await page.screenshot({ path: join(proof, "material-search-" + locale + ".png") });
      await result.click();
      await reader.locator("[data-slide-image]").waitFor({ timeout: 55000 });
      assert.deepEqual(
        (await reader.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.map(Number),
        [2, 2],
      );
      await reader.locator("[data-memory-material-back]").click();
      await waitFor(() => result.evaluate((element) => element === document.activeElement));
      const searchInput = search.locator("input");
      const recognizedQuery = path + "memory?" + new URLSearchParams({ q: recognizedImageText.en });
      if (withOcr) {
        const { materials } = await api(recognizedQuery);
        const match = materials.hits.find((item) => item.material.id === "drawing-sheet");
        assert.equal(match?.recognition, "ocr");
        assert.equal(match.location.kind, "image");
        assert(match.location.y < 0.25 && match.location.width > 0.3);
        assert.equal(
          (await api(path + "memory?" + new URLSearchParams({ q: recognizedImageText.excluded }))).materials.hits
            .length,
          0,
        );
        await searchInput.fill(recognizedImageText.en);
        await search.locator("button").click();
        const diagram = resultList.getByRole("button", { name: "Drawing sheet", exact: true });
        await diagram.waitFor();
        assert((await diagram.locator("..").textContent()).includes(recognitionLabels[locale]));
        await page.screenshot({ path: join(proof, "image-text-search-" + locale + ".png") });
        await diagram.click();
        await reader.locator(".memory-material-region").waitFor();
        await page.screenshot({ path: join(proof, "image-text-region-" + locale + ".png") });
        await reader.locator("[data-memory-material-back]").click();
        await waitFor(() => diagram.evaluate((element) => element === document.activeElement));
      }
      await searchInput.press("ControlOrMeta+a");
      await searchInput.press("Backspace");
      assert.equal(await searchInput.inputValue(), "");
      await search.locator("button").click();
      await page.locator("[data-memory-materials]").waitFor({ state: "hidden" });

      let activeSession;
      const sessions = "/api/personal/harness/conversations";
      const ask = async (projectId, term = searchTerm, runtimeId, existingSession) => {
        const session =
          existingSession ??
          (projectId === undefined
            ? activeSession
            : sessions +
              "/" +
              (await api(sessions, { projectId, ...(runtimeId ? { runtimeId } : {}) })).conversation.id);
        const before = app.calls().length;
        const question = "What was the " + term + " guidance?";
        await api(session + "/runs", { requestId: randomUUID(), text: question });
        await waitFor(async () => !(await api(session)).conversation.activeRunId);
        const calls = app.calls().slice(before);
        const prompt = runtimeId
          ? {
              params: {
                input: await capturedAcpPrompt(question),
              },
            }
          : calls.filter((call) => call.method === "turn/start").at(-1);
        assert(JSON.stringify(prompt).includes(question));
        return {
          session,
          prompt: JSON.stringify(prompt),
          images: prompt.params.input.filter((part) => part.type === "image"),
          created: calls.some((call) => call.method === "thread/start"),
        };
      };
      {
        assert.equal((await api(path + "memory-policy")).recall, false);
        const disabled = await ask(project.id);
        assert(!disabled.prompt.includes("Project material") && !disabled.images.length);
        const policy = await api(path + "memory-policy");
        const update = await context.request.patch(app.base + path + "memory-policy", {
          headers: { Origin: app.base },
          data: { ...policy, recall: true },
        });
        assert(update.ok());
        const captured = await ask(project.id);
        activeSession = captured.session;
        assert(captured.prompt.includes("Project material"));
        assert(captured.prompt.includes("Use Meridian coating."));
        assert(captured.images.some((part) => part.url.startsWith("data:image/")));
        const receipt = (await api(activeSession + "/memory")).recalls[0];
        assert.equal(receipt.status, "sent");
        const recalled = receipt.references.find(({ material }) => material?.file.name === "Site review.pptx");
        assert.deepEqual(recalled.material.location, { kind: "slide", number: 2 });
        assert.equal(recalled.material.packageId, projectMemory.packageId);
        assert.equal(recalled.material.file.digest, materials[0].files[0].digest);
        assert.equal(recalled.visual, true);
        if (locale === "en") {
          const vision = await ask(project.id, "Entry plan site accessibility", "grok-visual");
          assert(vision.prompt.includes('"visual":1') || vision.prompt.includes('\\"visual\\":1'));
          const dimensions = await Promise.all(
            vision.images.map(({ data, mimeType }) => {
              assert.match(mimeType, /^image\/(png|jpeg)$/u);
              return sharp(Buffer.from(data, "base64")).metadata();
            }),
          );
          assert(
            dimensions.some(({ width, height }) => width === 304 && height === 154),
            JSON.stringify(dimensions.map(({ width, height }) => [width, height])),
          );
          const pdfVision = await ask(project.id, "Site standards", "grok-visual");
          const pixels = await Promise.all(
            pdfVision.images.map(async ({ data }) => {
              const raster = sharp(Buffer.from(data, "base64"));
              const { width, height } = await raster.metadata();
              return raster
                .extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 })
                .removeAlpha()
                .raw()
                .toBuffer();
            }),
          );
          assert(pixels.some(([red, green, blue]) => red < 35 && green > 100 && blue > 135));
          const textOnly = await ask(project.id, searchTerm, "grok-text");
          assert.equal(textOnly.images.length, 0);
          assert(textOnly.prompt.includes("Use Meridian coating."));
          assert(!(await api(textOnly.session + "/memory")).recalls[0].references.some(({ visual }) => visual));
          if (withOcr) {
            const scanned = await ask(project.id, recognizedImageText.en, "grok-text");
            assert.equal(scanned.images.length, 0);
            assert(
              scanned.prompt.includes("optical character recognition") &&
                scanned.prompt.includes(recognizedImageText.en),
            );
            const scanReceipt = (await api(scanned.session + "/memory")).recalls[0];
            assert(
              scanReceipt.references.some(
                ({ material }) => material?.recognition === "ocr" && material.location?.kind === "image",
              ),
            );
          }
          writeFileSync(
            join(app.dir, "memory-grok-text", "auth.json"),
            JSON.stringify({
              fixture: { access_token: "fixture-only", visualInput: true, captureMemoryPrompt: true },
            }),
          );
          const recovered = await ask(project.id, "Meridian coating ramp", "grok-text", textOnly.session);
          assert(recovered.images.length > 0);
          assert((await api(recovered.session + "/memory")).recalls[0].references.some(({ visual }) => visual));
        }
        const sessionPage = await context.newPage();
        try {
          await sessionPage.goto(
            app.base + "/task/" + encodeURIComponent("harness:" + activeSession.split("/").at(-1)),
          );
          await sessionPage.locator("#sessionActionsButton").click();
          await sessionPage.locator('#sessionMemoryActions [data-session-action="memory-details"]').click();
          const sourceButton = sessionPage.locator("[data-recalled-material]").filter({ hasText: "Site review" });
          const marker = sourceButton.locator("..").locator("small");
          await marker.waitFor();
          assert.equal(await marker.textContent(), recallLabels[locale]);
          const memoryDetails = sessionPage.locator(".session-memory-dialog");
          assert(await memoryDetails.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
          await sessionPage.screenshot({ path: join(proof, "visual-recall-" + locale + ".png") });
          await sourceButton.click();
          const reader = sessionPage.locator(".memory-material-reader");
          await reader.locator("[data-slide-image]").waitFor({ timeout: 55000 });
          await reader.locator("[data-memory-material-back]").click();
          await waitFor(() => sourceButton.evaluate((element) => element === document.activeElement));
        } finally {
          await sessionPage.close();
        }
        const unrelated = await ask(null);
        assert(!unrelated.prompt.includes("Project material") && !unrelated.images.length);
      }

      const row = page
        .locator(".project-memory-entry")
        .filter({ has: page.getByRole("heading", { name: "accessibility", exact: true }) });
      await row.locator("[data-memory-sources] summary").click();
      await row.locator("[data-package-source]").click();
      const references = dialog.locator("[data-reference-materials]");
      await references.locator("[data-material=overview][data-memory-material-anchor]").waitFor();
      assert.equal(await references.getByText("Color samples").count(), 0);
      const deck = references.locator("[data-material=overview][data-memory-material-anchor]");
      if (locale === "zh-TW") {
        await page.route(
          "**/api/projects/*/memory-material-preview?*page=2",
          (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
          { times: 1 },
        );
      }
      await deck.click();
      if (locale === "zh-TW") await reader.locator("[data-slide-retry]").click();
      const slide = reader.locator("[data-slide-image]");
      await slide.waitFor({ timeout: 55000 });
      assert(await slide.evaluate((element) => element.naturalWidth >= 1000));
      assert.deepEqual(
        (await reader.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.map(Number),
        [2, 2],
      );
      await page.screenshot({ path: join(proof, "slides-" + locale + ".png") });
      if (locale === "en") {
        await reader.locator("[data-slide-previous]").click();
        await waitFor(async () => /1\s*\/\s*2/.test(await reader.locator("[data-slide-position]").textContent()));
      }
      await page.keyboard.press("Escape");
      await waitFor(() => deck.evaluate((element) => element === document.activeElement));

      await references.locator("[data-material=standards][data-memory-material-anchor]").click();
      await reader.locator("[data-slide-image]").waitFor({ timeout: 30000 });
      assert.deepEqual(
        (await reader.locator("[data-slide-position]").textContent()).match(/\d+/gu)?.map(Number),
        [2, 2],
      );
      await reader.locator("[data-memory-material-back]").click();

      await references.locator("[data-material=notes][data-memory-material-anchor]").click();
      const selected = reader.locator(".memory-material-target");
      await selected.waitFor();
      assert.equal(await selected.textContent(), "Keep the ramp entrance visible.");
      assert.equal(await reader.locator("script").count(), 0);
      assert(await selected.evaluate((element) => element === document.activeElement));
      await reader.locator("[data-memory-material-back]").click();

      await references.locator("[data-material=plan][data-memory-material-anchor]").click();
      const region = reader.locator(".memory-material-region");
      await region.waitFor();
      await reader.locator("img").evaluate((element) => element.decode());
      const bounds = await reader.locator("img").boundingBox();
      const box = await region.boundingBox();
      assert(bounds && box);
      assert(Math.abs(box.x - (bounds.x + bounds.width * 0.2)) <= 2);
      assert(Math.abs(box.width - bounds.width * 0.4) <= 2);
      assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: join(proof, "region-" + locale + ".png") });
      const resource = await reader.locator("img").getAttribute("src");
      const receiptPath = path + "memory-import?" + new URLSearchParams({ package: projectMemory.packageId });
      assert.equal((await context.request.get(app.base + resource)).headers()["cache-control"], "private, no-store");
      const otherProject = (await api("/api/projects")).projects.find((item) => item.code !== code);
      if (otherProject) {
        assert.equal(
          (await context.request.get(app.base + resource.replace(project.id, otherProject.id))).status(),
          404,
        );
      }
      let pendingSession, pausedHome;
      if (locale === "en") {
        writeFileSync(
          join(app.dir, "memory-grok-visual", "auth.json"),
          JSON.stringify({
            fixture: {
              access_token: "fixture-only",
              visualInput: true,
              captureMemoryPrompt: true,
              pauseMemoryDispatch: true,
            },
          }),
        );
        const session = await api(sessions, { projectId: project.id, runtimeId: "grok-visual" });
        pendingSession = sessions + "/" + session.conversation.id;
        const pending = await api(pendingSession + "/runs", {
          requestId: randomUUID(),
          text: "What is the Entry plan site accessibility guidance now?",
          effort: "low",
        });
        assert(pending.runId);
        pausedHome = await waitFor(async () => {
          for (const home of await readdir(nativeHomes)) {
            if (await Bun.file(join(nativeHomes, home, "memory-dispatch-paused")).exists())
              return join(nativeHomes, home);
          }
        });
        const planned = (await api(pendingSession + "/memory")).recalls[0];
        assert.equal(planned.status, "possible");
        assert(planned.references.some(({ visual }) => visual));
      }
      await api(path + "memory-import-withdraw", { packageId: projectMemory.packageId });
      if (pausedHome) {
        writeFileSync(join(pausedHome, "memory-dispatch-release"), "");
        await waitFor(async () => !(await api(pendingSession)).conversation.activeRunId);
        assert(!(await Bun.file(join(pausedHome, "memory-prompt.json")).exists()));
        assert((await api(pendingSession + "/memory")).recalls.every((receipt) => !receipt.references.length));
      }
      assert.equal((await context.request.get(app.base + resource)).status(), 404);
      assert.equal((await context.request.get(app.base + receiptPath)).status(), 404);
      assert.equal((await api(query)).materials.hits.length, 0);
      if (withOcr) assert.equal((await api(recognizedQuery)).materials.hits.length, 0);
      if (activeSession) {
        const next = await ask();
        assert(next.created);
        assert(!next.prompt.includes("Meridian coating.") && !next.prompt.includes("Project material"));
        assert.equal(next.images.length, 0);
        const receipts = (await api(activeSession + "/memory")).recalls;
        assert(receipts.every((receipt) => receipt.references.every((reference) => !reference.material)));
      }
    } finally {
      await browser.close();
    }
  }
  console.log("Project memory opens authorized slide, PDF, paragraph and image citations on desktop and H5.");
} finally {
  await app.dispose();
}
