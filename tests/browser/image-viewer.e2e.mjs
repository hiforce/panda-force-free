import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";
const directory = mkdtempSync(join(tmpdir(), "panda-force-agent-images-"));
const imageA = join(directory, "panda-force-agent-image-a.png");
const imageB = join(directory, "原始身份照.png");
const png = readFileSync(new URL("../../public/assets/panda-icon.png", import.meta.url));
const largePng = await sharp(png).resize(2400, 1800, { fit: "fill" }).png().toBuffer();
writeFileSync(imageA, largePng);
writeFileSync(imageB, png);
const runtime = await createBrowserFixture({ workspaceDirectory: directory });
const base = runtime.base;
let browser,
  page,
  stage = "startup";
let snapshotTurns = [];
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health/liveness`, { headers: runtime.headers })).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  const imageResponse = await fetch(
    `${base}/api/images/local?path=${encodeURIComponent(imageA)}&cwd=${encodeURIComponent("/tmp")}`,
    { headers: runtime.headers },
  );
  if (
    !imageResponse.ok ||
    imageResponse.headers.get("content-type") !== "image/png" ||
    !Buffer.from(await imageResponse.arrayBuffer()).equals(largePng)
  )
    throw new Error("Local image endpoint did not return the original PNG");
  const thumbnailResponse = await fetch(`${base}/api/images/local?path=${encodeURIComponent(imageA)}&thumbnail=1`, {
    headers: runtime.headers,
  });
  const compressed = Buffer.from(await thumbnailResponse.arrayBuffer()),
    metadata = await sharp(compressed).metadata();
  if (
    !thumbnailResponse.ok ||
    thumbnailResponse.headers.get("content-type") !== "image/webp" ||
    metadata.width !== 640 ||
    metadata.height !== 480 ||
    compressed.length >= largePng.length
  )
    throw new Error("Activity image endpoint did not compress the original");
  if (!readFileSync(imageA).equals(largePng)) throw new Error("Thumbnail generation modified the original file");
  const deniedResponse = await fetch(
    `${base}/api/images/local?path=${encodeURIComponent(new URL("../../package.json", import.meta.url).pathname)}`,
    { headers: runtime.headers },
  );
  if (deniedResponse.status !== 404)
    throw new Error(`Non-image local files must be rejected, got ${deniedResponse.status}`);
  const deniedThumbnail = await fetch(
    `${base}/api/images/local?path=${encodeURIComponent(new URL("../../package.json", import.meta.url).pathname)}&thumbnail=1`,
    { headers: runtime.headers },
  );
  if (deniedThumbnail.status !== 404) throw new Error("Thumbnails must retain the local file boundary");
  const crossSite = await fetch(`${base}/api/images/local?path=${encodeURIComponent(imageA)}&thumbnail=1`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  if (crossSite.status !== 401) throw new Error("Thumbnails must retain request authentication");
  browser = await runtime.launchBrowser(launchOptions());
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  const imageRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/images/local") imageRequests.push(request.url());
  });
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.params?.threadId !== "image-thread") return route.continue();
    let result = { data: [] };
    if (call.method === "host/thread/live") result = { active: false, turn: null };
    if (call.method === "host/thread/history")
      result = {
        thread: { id: "image-thread", cwd: directory },
        history: {
          mode: snapshotTurns.length ? "snapshot" : "delta",
          turns: snapshotTurns,
          revision: "image-test",
          nextCursor: null,
        },
      };
    if (call.method === "thread/goal/get") result = { goal: null };
    await route.fulfill({ json: { type: "rpc/result", id: call.id, result } });
  });
  await page.goto(base, { waitUntil: "networkidle" });
  stage = "application startup";
  await page.waitForFunction(() => globalThis.__pandaForceDebug);
  await page.evaluate(
    ({ imageA, imageB }) => {
      const api = globalThis.__pandaForceDebug;
      for (const key of ["items", "turns", "activities", "activityItems", "dividers"])
        api.mutations.collection(key).clear();
      (api.mutations.set("active", { id: "image-thread", cwd: api.state.config.defaultCwd, source: "local" }),
        api.workbench.threadOpened(api.state.active.id));
      document.querySelector("#conversation").replaceChildren();
      api.notify("item/completed", {
        turnId: "image-turn",
        item: { id: "image-view", type: "imageView", status: "completed", imagePaths: [imageA, imageB] },
      });
    },
    { imageA, imageB },
  );
  stage = "viewed-image thumbnails";
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".activity-image-grid img").length === 2 &&
      [...document.querySelectorAll(".activity-image-grid img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
  );
  if (imageRequests.length !== 2 || imageRequests.some((url) => new URL(url).searchParams.get("thumbnail") !== "1"))
    throw new Error(`Viewed-image activity fetched an original: ${JSON.stringify(imageRequests)}`);
  stage = "viewed-image live snapshot stability";
  await page.evaluate(
    ({ imageA, imageB }) => {
      const api = globalThis.__pandaForceDebug;
      window.__imageReceive = api.state.ws.onmessage;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.mutations.set("transport", "sse");
      window.__decodedViewedImages = [...document.querySelectorAll(".activity-image-grid img")];
      window.__viewedImageReloads = 0;
      for (const image of window.__decodedViewedImages)
        image.addEventListener("load", () => window.__viewedImageReloads++);
      const item = { id: "image-view", type: "imageView", status: "completed", imagePaths: [imageA, imageB] };
      for (let index = 0; index < 5; index++) {
        api.notify("item/completed", { turnId: "image-turn", item });
        api.syncTurnSnapshot({
          id: "image-turn",
          status: "inProgress",
          items: [item, { id: "image-progress", type: "agentMessage", text: "Continuing work " + index }],
        });
        const images = [...document.querySelectorAll(".activity-image-grid img")];
        if (images.some((image, index) => image !== window.__decodedViewedImages[index]))
          throw new Error("A live update replaced a decoded viewed-image thumbnail");
      }
    },
    { imageA, imageB },
  );
  stage = "viewed-image history resynchronization stability";
  snapshotTurns = [
    {
      id: "image-turn",
      status: "completed",
      items: [
        { id: "image-view", type: "imageView", status: "completed", imagePaths: [imageA, imageB] },
        { id: "image-progress", type: "agentMessage", text: "Viewed image history restored" },
      ],
    },
  ];
  await page.evaluate(() => window.__imageReceive({ data: JSON.stringify({ type: "bridge/resync" }) }));
  await page.getByText("Viewed image history restored", { exact: true }).waitFor();
  await page.evaluate(() => {
    const images = [...document.querySelectorAll(".activity-image-grid img")];
    if (images.length !== 2 || images.some((image, index) => image !== window.__decodedViewedImages[index]))
      throw new Error("History resynchronization replaced a decoded viewed-image thumbnail");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.__pandaForceDebug.setSidebarOpen(false));
  await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
  await page.locator(".activity-image-grid").scrollIntoViewIfNeeded();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error("Viewed images overflow the mobile viewport");
  await page.screenshot({ path: ".artifacts/viewed-image-stability-390.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => globalThis.__pandaForceDebug.setSidebarOpen(true));
  await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().left >= 0);
  await page.screenshot({ path: ".artifacts/viewed-image-stability-1280.png" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await page.evaluate(() => window.__viewedImageReloads)) throw new Error("A retained viewed image loaded again");
  if (imageRequests.length !== 2) throw new Error("Viewed-image updates requested the same thumbnails again");
  await page.locator(".activity-image-grid .message-image-button").first().click();
  stage = "activity original image";
  await page.waitForFunction(() => document.querySelector("#imageViewerImage")?.naturalWidth === 2400);
  const activityViewer = await page.evaluate(() => ({
    title: document.querySelector("#imageViewerTitle").textContent,
    source: document.querySelector("#imageViewerImage").getAttribute("src"),
    original: document.querySelector("#imageViewerOriginal").getAttribute("href"),
  }));
  if (
    activityViewer.title !== "panda-force-agent-image-a.png" ||
    activityViewer.source !== activityViewer.original ||
    activityViewer.source.includes("thumbnail=")
  )
    throw new Error(`Activity image lost its original: ${JSON.stringify(activityViewer)}`);
  await page.locator("#closeImageViewer").click();
  await page.evaluate(
    ({ imageA, imageB }) => {
      const api = globalThis.__pandaForceDebug;
      for (const key of ["items", "turns", "activities", "activityItems", "dividers"])
        api.mutations.collection(key).clear();
      document.querySelector("#conversation").replaceChildren();
      api.notify("item/completed", {
        turnId: "image-turn",
        item: {
          id: "image-commentary",
          type: "agentMessage",
          phase: "commentary",
          text: `Here is the captured result.\n\n![Agent screenshot](${imageA})\n\n[Open the screenshot](${imageA})`,
        },
      });
      api.notify("item/completed", {
        turnId: "image-turn",
        item: { id: "image-command-before", type: "commandExecution", status: "completed", command: "ls /tmp" },
      });
      api.notify("item/completed", {
        turnId: "image-turn",
        item: { id: "image-view", type: "imageView", status: "completed", imagePaths: [imageA, imageB] },
      });
      api.notify("item/completed", {
        turnId: "image-turn",
        item: { id: "image-command-after", type: "commandExecution", status: "completed", command: "ls /tmp" },
      });
      api.notify("item/completed", {
        turnId: "image-turn",
        item: {
          id: "image-generated",
          type: "imageGeneration",
          status: "completed",
          savedPath: imageB,
          title: "Generated preview",
        },
      });
      api.notify("item/completed", {
        turnId: "image-turn",
        item: {
          id: "image-final",
          type: "agentMessage",
          phase: "final_answer",
          content: [
            { type: "output_text", text: "The structured result is ready." },
            { type: "output_image", path: imageB, alt: "Structured result" },
          ],
        },
      });
    },
    { imageA, imageB },
  );
  stage = "all image surfaces";
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".message-image")].length === 5 &&
      [...document.querySelectorAll(".message-image")].every((image) => image.complete && image.naturalWidth > 0),
  );
  const result = await page.evaluate(() => {
    const viewGroup = document.querySelector('[data-item-id="image-view"]')?.closest("[data-agent-activity-group]");
    const viewRow = viewGroup?.querySelector('[data-item-id="image-view"]');
    const stream = document.querySelector('[data-turn-id="image-turn"] .turn-event-stream');
    const markdownButton = document.querySelector("[data-local-conversation-commentary] .message-image-button");
    return {
      imageCount: document.querySelectorAll(".message-image").length,
      localSources: [...document.querySelectorAll(".message-image")].map((image) => image.getAttribute("src")),
      timeline: [...stream.children].map((node) =>
        node.dataset.agentActivityGroup !== undefined
          ? `tools:${[...node.querySelectorAll(".activity-item")].map((row) => row.dataset.itemId).join(",")}`
          : node.className,
      ),
      activityGroupCount: document.querySelectorAll("[data-agent-activity-group]").length,
      imageViewStandalone: viewGroup?.dataset.standalone,
      imageViewExpanded: viewRow?.getAttribute("aria-expanded"),
      imageViewVisible:
        viewGroup && getComputedStyle(viewGroup.querySelector(".activity-image-output")).display !== "none",
      imageViewPreviewCount: viewGroup?.querySelectorAll(".message-image").length,
      imageViewSizes: [...viewGroup.querySelectorAll(".message-image")].map((image) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
        source: image.getAttribute("src"),
      })),
      imageViewIcon: viewRow?.querySelector(".activity-motion")?.innerHTML,
      generatedVisible: !!document.querySelector(".assistant-generated-image .message-image"),
      structuredVisible: !!document.querySelector(
        "[data-local-conversation-final-assistant] .structured-message-images .message-image",
      ),
      markdownButton,
    };
  });
  if (result.imageCount !== 5 || result.localSources.some((source) => !source?.startsWith("/api/images/local?")))
    throw new Error(`Images were not routed through the local endpoint: ${JSON.stringify(result)}`);
  if (
    result.activityGroupCount !== 3 ||
    result.imageViewStandalone !== "true" ||
    result.imageViewExpanded !== "true" ||
    !result.imageViewVisible ||
    result.imageViewPreviewCount !== 2
  )
    throw new Error(`imageView must be standalone and immediately viewable: ${JSON.stringify(result)}`);
  if (
    result.imageViewSizes.some(
      (image) => image.width > 640 || image.height > 640 || !image.source.includes("thumbnail=1"),
    )
  )
    throw new Error("Viewed images must display compressed thumbnails");
  if (result.localSources.filter((source) => source.includes("thumbnail=1")).length !== 3)
    throw new Error("Viewed and generated activity images should use compression");
  if (!result.imageViewIcon?.includes("<rect") || !result.generatedVisible || !result.structuredVisible)
    throw new Error(`Structured image surfaces were not rendered: ${JSON.stringify(result)}`);
  await page.locator("[data-local-conversation-commentary] .message-image-button").focus();
  await page.locator("[data-local-conversation-commentary] .message-image-button").click();
  await page.waitForSelector("#imageViewer[open]");
  await page.waitForFunction(() => document.querySelector("#imageViewerImage")?.naturalWidth > 0);
  await page.waitForFunction(() => document.activeElement === document.querySelector("#closeImageViewer"));
  const viewer = await page.evaluate(() => ({
    title: document.querySelector("#imageViewerTitle").textContent,
    path: document.querySelector("#imageViewerPath").textContent,
    source: document.querySelector("#imageViewerImage").getAttribute("src"),
    original: document.querySelector("#imageViewerOriginal").getAttribute("href"),
    closeFocused: document.activeElement === document.querySelector("#closeImageViewer"),
  }));
  if (
    viewer.title !== "Agent screenshot" ||
    viewer.path !== imageA ||
    viewer.source !== viewer.original ||
    !viewer.closeFocused
  )
    throw new Error(`Unexpected image viewer state: ${JSON.stringify(viewer)}`);
  await page.screenshot({ path: "/tmp/panda-force-image-viewer.png", fullPage: false });
  await page.locator("#closeImageViewer").click();
  if (
    !(await page
      .locator("[data-local-conversation-commentary] .message-image-button")
      .evaluate((node) => document.activeElement === node))
  )
    throw new Error("Closing the viewer must restore focus to the image preview");
  const citationResult = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let fileEvents = 0;
        addEventListener("panda-force:file-reference", () => fileEvents++);
        document.querySelector("[data-local-conversation-commentary] .image-citation").click();
        requestAnimationFrame(() =>
          resolve({
            fileEvents,
            open: document.querySelector("#imageViewer").open,
            title: document.querySelector("#imageViewerTitle").textContent,
          }),
        );
      }),
  );
  if (
    citationResult.fileEvents !== 0 ||
    !citationResult.open ||
    citationResult.title !== "panda-force-agent-image-a.png"
  )
    throw new Error(
      `Image citations must open the viewer instead of the file bridge: ${JSON.stringify(citationResult)}`,
    );
  await page.locator("#closeImageViewer").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-local-conversation-final-assistant] .message-image-button").click();
  const mobile = await page.evaluate(() => {
    const dialog = document.querySelector("#imageViewer").getBoundingClientRect();
    const image = document.querySelector("#imageViewerImage").getBoundingClientRect();
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dialogLeft: dialog.left,
      dialogRight: dialog.right,
      imageLeft: image.left,
      imageRight: image.right,
    };
  });
  if (
    mobile.scrollWidth > mobile.innerWidth ||
    mobile.dialogLeft < -0.5 ||
    mobile.dialogRight > mobile.innerWidth + 0.5 ||
    mobile.imageLeft < 0 ||
    mobile.imageRight > mobile.innerWidth + 0.5
  )
    throw new Error(`Image viewer overflows the mobile viewport: ${JSON.stringify(mobile)}`);
  await page.screenshot({ path: "/tmp/panda-force-image-viewer-mobile.png", fullPage: false });
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log(
    JSON.stringify(
      {
        endpoint: "ok",
        compression: {
          originalBytes: largePng.length,
          displayBytes: compressed.length,
          width: metadata.width,
          height: metadata.height,
        },
        activityViewer,
        result: { ...result, markdownButton: !!result.markdownButton },
        viewer,
        citationResult,
        mobile,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `Image viewer failure during ${stage}`,
    page &&
      (await page.evaluate(() => ({
        url: location.href,
        images: [...document.querySelectorAll(".message-image")].map((image) => ({
          src: image.getAttribute("src"),
          width: image.naturalWidth,
          complete: image.complete,
        })),
        active: globalThis.__pandaForceDebug?.state.active?.id,
        items: globalThis.__pandaForceDebug?.state.items?.size,
      }))),
  );
  throw error;
} finally {
  await browser?.close();
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
}
