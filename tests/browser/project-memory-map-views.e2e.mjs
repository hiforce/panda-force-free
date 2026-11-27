import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_MEMORY_MAP_VIEWS_PROOF || ".artifacts/project-memory-map-views";
await mkdir(proof, { recursive: true });
const app = await createAppFixture({
  applicationMemory: true,
  completedTurnNotifications: true,
  startupTimeoutMs: 70000,
});
const browsers = [];
const skins = [
  ["light", "light", "en"],
  ["dark", "graphite", "zh-CN"],
  ["silk", "silk", "zh-TW"],
  ["aurora", "aurora", "zh-HK"],
];
const request = (context, path, method = "GET", data) =>
  context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
async function api(context, path, method, data) {
  const response = await request(context, path, method, data);
  assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
  return response.json();
}
try {
  browsers.push(await chromium.launch());
  browsers.push(await webkit.launch());
  const auth = await browsers[0].newContext();
  await app.signIn(auth);
  const { revision } = await api(auth, "/api/projects");
  const { projects } = await api(auth, "/api/projects", "POST", {
    revision,
    name: "Atlas Lab",
    code: "atlas-lab",
    operationId: crypto.randomUUID(),
  });
  const project = projects.find(({ code }) => code === "atlas-lab");
  const endpoint = "/api/projects/" + project.id;
  const mapApi = endpoint + "/memory-terrain";
  await api(auth, endpoint + "/memory-policy", "PATCH", {
    revision: 0,
    write: true,
    recall: true,
    model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
  });
  const sessionApi = "/api/personal/harness/conversations";
  const send = async (text, count) => {
    const { conversation } = await api(auth, sessionApi, "POST", { runtimeId: "codex", projectId: project.id });
    await api(auth, sessionApi + "/" + conversation.id + "/runs", "POST", { text, requestId: crypto.randomUUID() });
    await waitFor(async () => (await api(auth, mapApi + "?view=overview")).places.length === count, 25000);
  };
  await send("As a Taipei-based architecture consultant, dumplings and noodles are my favorites.", 3);
  await send("The Taipei transit checklist depends on the confirmed architecture role.", 4);
  const overview = await api(auth, mapApi + "?view=overview");
  const profile = overview.places.find(({ entry }) => entry.title === "Profile").entry.id;
  const transit = overview.places.find(({ entry }) => entry.title === "Transit checklist").entry.id;
  const timeline = await api(auth, mapApi + "?view=timeline");
  const times = timeline.places.map(({ time }) => time.at);
  assert(times.every((at, index) => at > 0 && (!index || at >= times[index - 1])));
  assert(timeline.places.every(({ time }) => time.source));
  const focus = await api(auth, mapApi + "?view=focus&hops=2&place=" + profile);
  assert.equal(focus.place, profile);
  assert.equal(focus.places.find(({ entry }) => entry.id === transit).depth, 2);
  assert.equal((await request(auth, mapApi + "?view=focus&hops=3")).status(), 400);
  await auth.close();

  for (const [browser, width] of [
    [browsers[0], 1440],
    [browsers[1], 320],
  ]) {
    for (const [preference, skin, locale] of skins) {
      const mobile = width < 760;
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 890 : 1000 },
        locale,
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: "reduce",
      });
      try {
        await app.signIn(context);
        await context.addInitScript(
          ({ preference, locale }) => {
            localStorage.setItem("panda-force-theme", preference);
            localStorage.setItem("panda-force-locale", locale);
          },
          { preference, locale },
        );
        const page = await context.newPage();
        page.setDefaultTimeout(24000);
        const origins = new Set();
        page.on("request", (item) => origins.add(item.url()));
        const route = app.base + "/project?id=" + project.id + "&tab=memory";
        await page.goto(route);
        const picker = page.locator("[data-memory-layout]");
        const scene = page.locator(".memory-terrain-scene");
        const canvas = scene.locator("canvas");
        const detail = page.locator("[data-memory-place-detail]");
        const marker = (id) => scene.locator('[data-memory-place="' + id + '"]');
        await marker(profile).waitFor();
        assert.equal(await picker.inputValue(), "network");
        assert.equal(await page.locator("html").getAttribute("data-appearance"), skin);
        await marker(profile).press("Enter");
        async function capture(layout, links) {
          const view = page.locator('[data-memory-arrangement="' + layout + '"]');
          await view.waitFor();
          await view.locator('canvas[data-memory-links="' + links + '"]').waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const collisions = await scene.evaluate((root) => {
            const bounds = root.getBoundingClientRect();
            const boxes = [...root.querySelectorAll(".memory-terrain-marker")].map((marker) =>
              marker.getBoundingClientRect(),
            );
            return boxes.some(
              (a, index) =>
                a.x < bounds.left ||
                a.right > bounds.right ||
                a.top < bounds.top ||
                a.bottom > bounds.bottom ||
                a.height < 44 ||
                boxes.slice(index + 1).some((b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y),
            );
          });
          assert(!collisions, "Collisions in " + skin + " " + layout + " " + width);
          await scene.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(proof, [skin, layout, width].join("-") + ".png") });
        }
        await capture("network", 4);
        await picker.selectOption("timeline");
        await capture("timeline", 4);
        assert.equal(await scene.locator("time[datetime]").count(), 4);
        await page.locator("[data-memory-filter]").selectOption("dependency");
        await scene.locator('canvas[data-memory-links="1"]').waitFor();
        assert.equal(await marker(profile).getAttribute("aria-pressed"), "true");

        await picker.selectOption("focus");
        await capture("focus", 4);
        assert.equal(await marker(transit).getAttribute("data-memory-depth"), "2");
        await page.locator('[data-memory-hops="1"]').press("Enter");
        await waitFor(async () => (await scene.locator("[data-memory-place]").count()) === 3);
        assert.equal(await marker(transit).count(), 0);
        await page.locator('[data-memory-hops="2"]').press("Enter");
        await detail.locator('[data-memory-related="' + transit + '"]').press("Enter");
        await waitFor(async () => (await marker(transit).getAttribute("data-memory-depth")) === "0");
        assert(await marker(transit).evaluate((element) => element === document.activeElement));
        await page.locator('[data-memory-hops="1"]').press("Enter");
        await waitFor(async () => (await scene.locator("[data-memory-place]").count()) === 2);
        const source = detail.locator("[data-memory-source-message]");
        await source.locator("summary").click();
        await source.locator("blockquote").waitFor();
        const sourceHref = await source.locator("a").getAttribute("href");
        assert.equal(new URL(sourceHref, app.base).searchParams.get("mapLayout"), "focus");
        assert.equal(new URL(sourceHref, app.base).searchParams.get("hops"), "1");
        await page.reload();
        await marker(transit).waitFor();
        assert.equal(await picker.inputValue(), "focus");
        assert.equal(await marker(transit).getAttribute("data-memory-depth"), "0");
        if (process.env.PANDA_FORCE_REQUIRE_CDN) {
          const manifest = await Bun.file("public/cdn-manifest.json").json();
          for (const path of ["/app.bundle.js", "/workbench.css", "/appearance.css", "/http-client.js"])
            assert(origins.has(manifest.assets[path].url), "Expected CDN request for " + path);
          for (const request of origins) {
            const url = new URL(request);
            if (url.pathname.startsWith("/api/")) assert.equal(url.origin, app.base);
          }
        }
        assert.equal(await canvas.getAttribute("data-memory-links"), "1");
      } finally {
        await context.close();
      }
    }
  }
  console.log("All three memory map layouts passed on desktop and H5 with all four appearances.");
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await app.dispose();
}
