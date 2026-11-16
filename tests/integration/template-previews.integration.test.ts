import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { builtinTemplateSource } from "../../src/server/templates/integration/presentation-source.js";
import { TemplatePreviewRepository } from "../../src/server/template-previews/repository.js";
import { TemplatePreviewService } from "../../src/server/template-previews/service.js";
import { FileTemplatePreviewImages } from "../../src/server/template-previews/files.js";
import { TemplatePreviewError } from "../../src/server/template-previews/errors.js";
import {
  TEMPLATE_PREVIEW_RENDERER,
  type TemplatePreviewRaster,
  type TemplatePreviewJob,
} from "../../src/shared/template-previews/contracts.js";
const pause = () => Bun.sleep(25);
async function until(read: () => TemplatePreviewJob, phase: string) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (value.phase === phase) return value;
    if (Date.now() > end) throw new Error("Preview did not settle: " + value.phase);
    await pause();
  }
}
async function raster(): Promise<TemplatePreviewRaster> {
  const images = {} as TemplatePreviewRaster["images"];
  for (const view of ["home", "article", "mobile"] as const) {
    const width = view === "mobile" ? 390 : 1440,
      height = view === "mobile" ? 844 : 960;
    images[view] = {
      width,
      height,
      png: (
        await sharp({ create: { width, height, channels: 3, background: "#eee9e2" } })
          .png()
          .toBuffer()
      ).toString("base64"),
    };
  }
  return { schema: 1, renderer: TEMPLATE_PREVIEW_RENDERER, images };
}
test("real file cache, admission coalescing, private lookup and restart preserve screenshot receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-template-previews-"));
  const template = (await builtinTemplateSource().read()).templates.find(
    (value) => value.reference.registry === "builtin" && value.reference.id === "panda.reader",
  )!;
  let builds = 0,
    renders = 0,
    disabled = false;
  const files = new FileTemplatePreviewImages(join(root, "images"));
  const open = () => {
    const jobs = new TemplatePreviewRepository(join(root, "jobs.sqlite"));
    const service = new TemplatePreviewService(
      jobs,
      { resolve: async () => ({ ...template, state: { ...template.state, enabled: !disabled } }) },
      {
        pages: async () => {
          builds++;
          return { state: "ready", home: "<h1>Public home</h1>", article: "<h1>Public article</h1>" };
        },
      },
      {
        render: async (input) => {
          expect(input.home).toContain("Public home");
          renders++;
          return raster();
        },
      },
      files,
      (error) => {
        throw error;
      },
    );
    return { jobs, service };
  };
  let current = open();
  try {
    const id = randomUUID(),
      key = template.key;
    await current.service.start("owner", id, key, "en");
    const duplicate = await current.service.start("owner", randomUUID(), key, "en");
    expect(duplicate.id).toBe(id);
    const ready = await until(() => current.jobs.get("owner", id), "ready");
    expect(Object.keys(ready.images)).toHaveLength(3);
    expect(renders).toBe(1);
    expect(builds).toBe(1);
    expect((await sharp(await current.service.image("owner", id, "mobile")).metadata()).width).toBe(390);
    await expect(current.service.detail("different-owner", id)).rejects.toMatchObject({ code: "notFound" });
    disabled = true;
    await expect(current.service.image("owner", id, "home")).rejects.toMatchObject({ code: "disabled" });
    disabled = false;
    await current.service.close();
    current.jobs.close();
    current = open();
    expect((await current.service.lookup("owner", key, "en"))?.id).toBe(id);
    expect(await current.service.image("owner", id, "article")).toEqual(await files.read(ready, "article"));
    expect(renders).toBe(1);
    const regionalIds = [];
    for (const locale of ["zh-HK", "zh-TW"] as const) {
      const job = await current.service.start("owner", randomUUID(), key, locale);
      await until(() => current.jobs.get("owner", job.id), "ready");
      expect(job.locale).toBe(locale);
      expect((await current.service.lookup("owner", key, locale))?.id).toBe(job.id);
      regionalIds.push(job.id);
    }
    expect(new Set(regionalIds).size).toBe(2);
    await expect(current.service.lookup("owner", key, "fr" as never)).rejects.toMatchObject({ code: "invalidInput" });
  } finally {
    await current.service.close();
    current.jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("failed renderer is retryable, a new generation fences old leases and raster validation rejects a false viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-preview-failure-"));
  const template = (await builtinTemplateSource().read()).templates.find(
    (value) => value.reference.registry === "builtin" && value.reference.id === "panda.reader",
  )!;
  const jobs = new TemplatePreviewRepository(join(root, "jobs.sqlite")),
    files = new FileTemplatePreviewImages(join(root, "images"));
  let fail = true;
  const service = new TemplatePreviewService(
    jobs,
    { resolve: async () => template },
    { pages: async () => ({ state: "ready", home: "home", article: "article" }) },
    {
      render: async () => {
        if (fail) throw new TemplatePreviewError("unavailable");
        return raster();
      },
    },
    files,
    () => {},
  );
  try {
    const id = randomUUID();
    await service.start("owner", id, template.key, "en");
    const failed = await until(() => jobs.get("owner", id), "failed");
    expect(failed.failure).toBe("renderUnavailable");
    fail = false;
    const next = await service.retry("owner", id);
    expect(next.generation).toBe(2);
    await until(() => jobs.get("owner", id), "ready");
    const bad = await raster();
    bad.images.mobile.width = 1440;
    await expect(files.write(randomUUID(), bad)).rejects.toMatchObject({ code: "unavailable" });
    await service.close();
    jobs.retry("owner", id);
    const old = jobs.claim()!;
    expect(() => jobs.save(id, randomUUID(), { phase: "ready" })).toThrow("conflict");
    jobs.save(id, old.token, { phase: "failed" });
  } finally {
    await service.close();
    jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});
