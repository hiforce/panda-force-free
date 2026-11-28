import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageRenderJournal } from "../../src/server/creation/integration/rendering/image-journal.js";
import { CreationGeneratedOriginals } from "../../src/server/creation/integration/rendering/generated-originals.js";
import { nativeCreationGenerators } from "../../src/server/creation/integration/rendering/generators.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { CreationMediaExecutors } from "../../src/server/creation/integration/media-executors/service.js";
import { CreationMediaJobs, type MediaJobScope } from "../../src/server/creation/integration/media-executors/jobs.js";
import { stableJson } from "../../src/shared/stable-json.js";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { creationAppFixture } from "../support/creation-app.js";

const picture = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEElEQVR4nGP4z8AARAzYKAB3pAf53le34gAAAABJRU5ErkJggg==";

test("Claude Code can use an explicit image API executor to save an illustrated editable PPTX", async () => {
  let media!: CreationMediaExecutors;
  let requests = 0;
  const f = await creationAppFixture({
    assets: true,
    runtimes: {
      async resolve(_owner, selection) {
        expect(selection.runtimeId).toBe("claude-host");
        return { runtimeId: "claude-host", model: "opus", effort: "" };
      },
    },
    content(files, root) {
      const send = (async (url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
        if (init?.method === "POST") {
          expect(url).toBe("https://api.x.ai/v1/images/generations");
          expect(JSON.parse(String(init.body))).toMatchObject({ model: "grok-imagine-image-2.0" });
          requests++;
          return Response.json({ data: [{ b64_json: picture }] });
        }
        return Response.json({ id: "grok-imagine-image-2.0" });
      }) as typeof fetch;
      media = new CreationMediaExecutors(root, {}, send);
      return {
        documents: creationFileDocuments(files.application()),
        media,
        image: {
          journal: new ImageRenderJournal(join(root, "images")),
          renderer: {
            async render() {
              throw Error("Native renderer was not selected");
            },
          },
          available: async () => false,
          assets: async () => files.application().creations,
          generated: new CreationGeneratedOriginals(join(root, "generated")),
          generators: nativeCreationGenerators(),
          mediaJobs: new CreationMediaJobs(join(root, "jobs"), media, 1),
        },
      };
    },
  });
  try {
    const id = randomUUID(),
      executorId = randomUUID();
    const request = {
      id,
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      locale: "zh-CN",
      prompt: "做一份有配图的古希腊简史。",
      profileId: "codex",
      runtimeId: "claude-host",
      model: "opus",
      outputType: "slides",
      selections: [],
    };
    const absent = await f.files.call("/api/document-creations", "POST", request);
    expect(absent.status).toBeGreaterThanOrEqual(400);
    expect(absent.body.code).toBe("runtimeSelectionUnavailable");
    const native = await f.files.call("/api/document-creations", "POST", {
      ...request,
      media: { kind: "image", source: "harness" },
    });
    expect(native.status).toBeGreaterThanOrEqual(400);
    const saved = await media.save("operator:test-user", {
      id: executorId,
      preset: "grok-image",
      apiKey: "fixture-key",
      revision: 0,
    });
    expect(saved.kind).toBe("image");
    f.onRun(async (input, callbacks, scope) => {
      const changedMedia = await f.files.call("/api/document-creations/message", "POST", {
        taskId: id,
        id: randomUUID(),
        prompt: "Use a different image source",
        media: { kind: "image", source: "harness" },
      });
      expect(changedMedia.status).toBe(409);
      expect(input.instructions).toContain("picture page");
      for (const value of ["fixture-key", "https://api.x.ai", executorId, "grok-imagine-image-2.0"])
        expect(JSON.stringify(input)).not.toContain(value);
      const call = (name: string, args: unknown) =>
        callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
      const context = await call("panda_creation_context", {});
      expect(context.success).toBe(true);
      for (const value of ["fixture-key", "https://api.x.ai", executorId, "grok-imagine-image-2.0"])
        expect(context.text).not.toContain(value);
      const title = "古希腊简史";
      const cover = { layout: "cover", title, body: "城邦与文明" };
      const invalid = await call("panda_slides_render", { slot: 1, pages: [cover] });
      expect(invalid.success).toBe(false);
      for (const fields of [
        { baseUrl: "https://substitute.invalid/v1" },
        { executorId: randomUUID() },
        { apiKey: "supplied-by-harness" },
        { model: "other-model" },
      ]) {
        const tampered = await call("panda_images_render", { slot: 1, prompt: "一张描绘古希腊城邦的插图", ...fields });
        expect(tampered.success).toBe(false);
      }
      expect(requests).toBe(0);
      const image = await call("panda_images_render", { slot: 1, prompt: "一张描绘古希腊城邦的插图" });
      expect(image.success).toBe(true);
      for (const value of ["fixture-key", "https://api.x.ai", executorId, "grok-imagine-image-2.0"])
        expect(image.text).not.toContain(value);
      const { jobId, handle } = JSON.parse(image.text);
      expect(jobId).toMatch(/^[a-f0-9]{64}$/);
      const status = await call("panda_media_job_status", { jobId });
      expect(status.success).toBe(true);
      expect(JSON.parse(status.text)).toEqual({ jobId, state: "ready" });
      const missing = await call("panda_media_job_status", { jobId: "0".repeat(64) });
      expect(missing.success).toBe(false);
      expect(JSON.parse(missing.text).error).toBe("notFound");
      const repeated = await call("panda_images_render", { slot: 1, prompt: "一张描绘古希腊城邦的插图" });
      expect(repeated.success).toBe(true);
      expect(JSON.parse(repeated.text)).toMatchObject({ jobId, handle });
      const render = await call("panda_slides_render", {
        slot: 1,
        pages: [
          cover,
          {
            layout: "picture",
            title: "城邦的兴起",
            body: "地中海沿岸出现独立城邦",
            imageHandle: handle,
          },
        ],
      });
      expect(render.success).toBe(true);
      expect(
        (await call("panda_artifacts_save", { kind: "slides", title, handle: JSON.parse(render.text).handle })).success,
      ).toBe(true);
    });
    const accepted = await f.files.call("/api/document-creations", "POST", {
      ...request,
      media: { kind: "image", source: "executor", executorId },
    });
    expect(accepted.status).toBe(202);
    const task = await f.until(id, (value) => value.state === "succeeded" || !!value.failure);
    expect(task).toMatchObject({ state: "succeeded", runtimeId: "claude-host", model: "opus", media: { executorId } });
    if (!task.artifact || task.artifact.kind !== "slides") throw Error("Missing original presentation");
    const original = await f.files.application().creations.original("project-1", task.artifact.assetId);
    const deck = await NativePresentation.open(original.bytes, "brief.pptx");
    expect(deck.index.slides).toHaveLength(2);
    const shapes = deck.part(deck.index.slides[1]!.path).shapes;
    expect(shapes.some((shape) => shape.kind === "picture")).toBe(true);
    expect(shapes.some((shape) => shape.kind === "text" && shape.text === "城邦的兴起")).toBe(true);
    expect(requests).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([
  ["restore the original", false],
  ["stop waiting without deleting the Seedance job", true],
] as const)(
  "the application recovers a Seedance receipt to %s",
  async (_description, shouldCancel) => {
    const original = await readFile(new URL("../support/media/preview.mp4", import.meta.url));
    const generating = Promise.withResolvers<void>(),
      downloaded = Promise.withResolvers<void>(),
      continueHarness = Promise.withResolvers<void>();
    let finished = false,
      submissions = 0,
      downloads = 0,
      queries = 0,
      jobs!: CreationMediaJobs;
    const send = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tasks") && init?.method === "GET") return Response.json({ items: [] });
      if (init?.method === "POST") {
        submissions++;
        return Response.json({ id: "cgt-restarted" });
      }
      if (url.pathname.endsWith("/original.mp4")) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        if (++downloads === 1) return new Response(null, { status: 503 });
        downloaded.resolve();
        return new Response(original);
      }
      expect(url.pathname).toMatch(/\/tasks\/cgt-restarted$/);
      expect(init?.method).toBe("GET");
      queries++;
      if (!finished) {
        generating.resolve();
        return Response.json({ id: "cgt-restarted", status: "running" });
      }
      return Response.json({
        id: "cgt-restarted",
        status: "succeeded",
        content: { video_url: "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/original.mp4" },
      });
    }) as typeof fetch;
    let media!: CreationMediaExecutors;
    const f = await creationAppFixture({
      assets: true,
      content(files, root) {
        media = new CreationMediaExecutors(root, {}, send);
        jobs = new CreationMediaJobs(join(root, "jobs"), media, 10);
        return {
          documents: creationFileDocuments(files.application()),
          media,
          image: {
            journal: new ImageRenderJournal(join(root, "images")),
            renderer: {
              async render() {
                throw Error("Unexpected image render");
              },
            },
            available: async () => false,
            assets: async () => files.application().creations,
            generated: new CreationGeneratedOriginals(join(root, "generated")),
            generators: nativeCreationGenerators(),
            mediaJobs: jobs,
          },
        };
      },
    });
    try {
      const id = randomUUID(),
        executorId = randomUUID();
      await media.save("operator:test-user", {
        id: executorId,
        preset: "seedance-video",
        apiKey: "fixture-key",
        revision: 0,
      });
      f.onRun(async (_input, callbacks, scope) => {
        if (f.runs() > 1) await continueHarness.promise;
        const call = (name: string, args: unknown) =>
          callbacks.call({ ...scope, callId: randomUUID(), name, arguments: args });
        await call("panda_creation_context", {});
        const video = await call("panda_videos_generate", { slot: 1, prompt: "A short title sequence" });
        if (shouldCancel) return;
        expect(video.success).toBe(true);
        const saved = await call("panda_artifacts_save", {
          kind: "video",
          title: "Restored title sequence",
          handle: JSON.parse(video.text).handle,
        });
        expect(saved.success).toBe(true);
      });
      const created = await f.files.call("/api/document-creations", "POST", {
        id,
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        locale: "en",
        prompt: "Make a short video",
        profileId: "codex",
        selections: [],
        outputType: "video",
        media: { kind: "video", source: "executor", executorId },
      });
      expect(created.status).toBe(202);
      await generating.promise;
      if (shouldCancel) {
        const cancelled = await f.files.call("/api/document-creations/cancel", "POST", { id });
        expect(cancelled.status).toBe(200);
        expect((await f.until(id, (value) => value.state === "cancelled")).state).toBe("cancelled");
      }
      await f.restart();
      const errors: unknown[] = [];
      if (shouldCancel) {
        const recovered = Promise.withResolvers<MediaJobScope>();
        const queriesBeforeRecovery = queries;
        jobs.start(
          async (scope) => {
            const action = await f.recoverMedia(scope);
            if (action === "cancel") recovered.resolve(scope);
            return action;
          },
          (error) => errors.push(error),
        );
        const scope = await Promise.race([
          recovered.promise,
          Bun.sleep(1000).then(() => {
            throw Error("Cancellation was not recovered");
          }),
        ]);
        const callId = createHash("sha256")
          .update(stableJson({ task: id, input: scope.inputDigest, slot: 1 }))
          .digest("hex");
        const jobId = await jobs.existingId(scope, callId, "A short title sequence");
        if (!jobId) throw Error("Missing durable media job ID");
        const status = () => jobs.status(scope, jobId);
        const deadline = Date.now() + 1000;
        while ((await status()) !== "stoppedLocally" && Date.now() < deadline) await Bun.sleep(10);
        expect(await status()).toBe("stoppedLocally");
        expect({ queries, downloads, submissions }).toEqual({
          queries: queriesBeforeRecovery,
          downloads: 0,
          submissions: 1,
        });
        expect(errors).toEqual([]);
        return;
      }
      finished = true;
      jobs.start(f.recoverMedia, (error) => errors.push(error));
      await downloaded.promise;
      expect(submissions).toBe(1);
      expect(downloads).toBe(2);
      expect(errors).toMatchObject([{ code: "unavailable" }]);
      continueHarness.resolve();
      const task = await f.until(id, (value) => value.state === "succeeded" || !!value.failure);
      expect(task.state).toBe("succeeded");
      if (!task.artifact || task.artifact.kind !== "video") throw Error("Missing video original");
      expect((await f.files.application().creations.original("project-1", task.artifact.assetId)).bytes).toEqual(
        original,
      );
      expect(submissions).toBe(1);
    } finally {
      continueHarness.resolve();
      await jobs.close();
      await f.close();
    }
  },
  12000,
);
