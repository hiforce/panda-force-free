import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiMediaPresets } from "../../src/server/creation/integration/media-executors/presets.js";
import { mediaApiProvider } from "../../src/server/creation/integration/media-executors/api-provider.js";
import { CreationMediaExecutors } from "../../src/server/creation/integration/media-executors/service.js";

const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEElEQVR4nGP4z8AARAzYKAB3pAf53le34gAAAABJRU5ErkJggg==";
const png = Buffer.from(encoded, "base64");
const prompt = "A white square on a navy background.";
const ideogramDownload = "https://ideogram.ai/api/images/ephemeral/test.png";
const wanDownload = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.png?Expires=123";
const fluxDownload = "https://delivery.eu4.bfl.ai/results/test.png";
const fluxId = "143c171c-e221-4bf9-87dc-0ca1deb79dcc";
const fluxPoll = "https://api.eu4.bfl.ai/v1/get_result?id=" + fluxId;

type Call = {
  path: string;
  header: string;
  credential: string;
  body: object;
  reply: () => Response;
};

const payload = (data: object) => () => Response.json(data);
const raster = () => new Response(png, { headers: { "content-type": "image/png" } });
const base64Reply = payload({ data: [{ b64_json: encoded }] });

const supported: readonly {
  preset: string;
  model: string;
  checkPath?: string;
  submit: Call;
  download?: string;
}[] = [
  {
    preset: "google-image",
    model: "gemini-nano-banana-2.1",
    checkPath: "/v1beta/models/gemini-nano-banana-2.1",
    submit: {
      path: "/v1beta/interactions",
      header: "x-goog-api-key",
      credential: "fixture-key",
      body: {
        model: "gemini-nano-banana-2.1",
        input: [{ type: "text", text: prompt }],
        store: false,
        response_format: { type: "image" },
      },
      reply: payload({
        steps: [
          { type: "thought", summary: [{ type: "image", data: "discarded" }] },
          { type: "model_output", content: [{ type: "image", data: encoded }] },
        ],
      }),
    },
  },
  {
    preset: "stability-image",
    model: "sd3.5-medium",
    submit: {
      path: "/v2beta/stable-image/generate/sd3",
      header: "Authorization",
      credential: "Bearer fixture-key",
      body: { prompt, model: "sd3.5-medium", output_format: "png" },
      reply: raster,
    },
  },
  {
    preset: "stability-image",
    model: "ultra",
    submit: {
      path: "/v2beta/stable-image/generate/ultra",
      header: "Authorization",
      credential: "Bearer fixture-key",
      body: { prompt, output_format: "png" },
      reply: raster,
    },
  },
  {
    preset: "seedream-image",
    model: "doubao-seedream-5-5-261028",
    submit: {
      path: "/api/v3/images/generations",
      header: "Authorization",
      credential: "Bearer fixture-key",
      body: { prompt, model: "doubao-seedream-5-5-261028", response_format: "b64_json", stream: false, size: "2K" },
      reply: base64Reply,
    },
  },
  {
    preset: "recraft-image",
    model: "recraftv4_1",
    checkPath: "/v1/users/me",
    submit: {
      path: "/v1/images/generations",
      header: "Authorization",
      credential: "Bearer fixture-key",
      body: { prompt, model: "recraftv4_1", response_format: "b64_json", image_format: "png" },
      reply: base64Reply,
    },
  },
  {
    preset: "ideogram-image",
    model: "ideogram-4-6",
    checkPath: "/v2/image/generate/ideogram-4-6?dry_run=true",
    submit: {
      path: "/v2/image/generate/ideogram-4-6",
      header: "Api-Key",
      credential: "fixture-key",
      body: { prompt, num_images: 1 },
      reply: payload({ data: [{ url: ideogramDownload, is_image_safe: true }] }),
    },
    download: ideogramDownload,
  },
  {
    preset: "wan-image",
    model: "wan2.7-image",
    submit: {
      path: "/api/v1/services/aigc/multimodal-generation/generation",
      header: "Authorization",
      credential: "Bearer fixture-key",
      body: {
        model: "wan2.7-image",
        input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
        parameters: { size: "2K", n: 1 },
      },
      reply: payload({ output: { choices: [{ message: { content: [{ image: wanDownload }] } }] } }),
    },
    download: wanDownload,
  },
  {
    preset: "fal-image",
    model: "fal-ai/flux-2-pro",
    submit: {
      path: "/fal-ai/flux-2-pro",
      header: "Authorization",
      credential: "Key fixture-key",
      body: { prompt, num_images: 1, sync_mode: true },
      reply: payload({ images: [{ url: "data:image/png;base64," + encoded }] }),
    },
  },
];

for (const fixture of supported) {
  test(`${fixture.model} registers, uses the model-specific protocol and returns original bytes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-image-catalog-"));
    const touched: string[] = [];
    const preset = apiMediaPresets.find((item) => item.id === fixture.preset)!;
    try {
      const send = (async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname + url.search;
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("error");
        touched.push(path);
        if (url.href === fixture.download) {
          expect([...headers.keys()]).toEqual([]);
          return raster();
        }
        expect(url.origin).toBe(new URL(preset.baseUrl).origin);
        expect(headers.get(fixture.submit.header)).toBe(fixture.submit.credential);
        if (path === fixture.checkPath) return Response.json({ ok: true });
        expect(init?.method).toBe("POST");
        expect(path).toBe(fixture.submit.path);
        if (init?.body instanceof FormData) {
          expect(headers.get("content-type")).toBeNull();
          expect(headers.get("accept")).toBe("image/*");
          expect(Object.fromEntries(init.body)).toEqual(fixture.submit.body);
        } else {
          expect(JSON.parse(String(init?.body))).toEqual(fixture.submit.body);
        }
        return fixture.submit.reply();
      }) as typeof fetch;
      const service = new CreationMediaExecutors(root, {}, send);
      const id = randomUUID();
      await service.save("user", { id, preset: preset.id, model: fixture.model, apiKey: "fixture-key", revision: 0 });
      const binding = await service.bind("user", { kind: "image", source: "executor", executorId: id });
      expect(binding.model).toBe(fixture.model);
      expect(await service.submit("user", binding, id, prompt, new AbortController().signal)).toEqual({
        state: "succeeded",
        bytes: png,
      });
      expect((await service.list("user")).executors[0]?.status).toBe("connected");
      expect(touched).toEqual([
        ...(fixture.checkPath ? [fixture.checkPath] : []),
        fixture.submit.path,
        ...(fixture.download ? [new URL(fixture.download).pathname + new URL(fixture.download).search] : []),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("FLUX uses the returned region after restart and never forwards its key to the download host", async () => {
  const preset = apiMediaPresets.find((item) => item.id === "flux-image")!;
  const connection = { baseUrl: preset.baseUrl, apiKey: "fixture-key" };
  const signal = new AbortController().signal;
  const input = { kind: "image", model: "flux-2-pro", prompt, id: randomUUID() } as const;
  const create = (pollingUrl: string) =>
    (async (url, init) => {
      expect(String(url)).toBe("https://api.bfl.ai/v1/flux-2-pro");
      expect(new Headers(init?.headers).get("x-key")).toBe(connection.apiKey);
      return Response.json({ id: fluxId, polling_url: pollingUrl });
    }) as typeof fetch;
  const result = await mediaApiProvider(preset, create(fluxPoll)).submit(connection, input, signal);
  expect(result).toEqual({ state: "pending", taskId: "eu4_" + fluxId });
  let polls = 0;
  const restored = mediaApiProvider(preset, (async (url, init) => {
    const headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("error");
    if (String(url) === fluxDownload) {
      expect([...headers.keys()]).toEqual([]);
      return raster();
    }
    expect(String(url)).toBe(fluxPoll);
    expect(headers.get("x-key")).toBe(connection.apiKey);
    return Response.json(
      ++polls === 1
        ? { id: fluxId, status: "Generating" }
        : { id: fluxId, status: "Ready", result: { sample: fluxDownload } },
    );
  }) as typeof fetch);
  expect(await restored.poll!(connection, "eu4_" + fluxId, signal)).toEqual(result);
  expect(await restored.poll!(connection, "eu4_" + fluxId, signal)).toEqual({
    state: "succeeded",
    bytes: png,
    invocationId: fluxId,
  });
  await expect(
    mediaApiProvider(preset, create("https://api.eu4.bfl.ai.invalid/v1/get_result?id=" + fluxId)).submit(
      connection,
      input,
      signal,
    ),
  ).rejects.toMatchObject({ code: "uncertain" });
});

test("Provider-generated download URLs are restricted before the worker fetches them", async () => {
  const preset = apiMediaPresets.find((item) => item.id === "ideogram-image")!;
  let calls = 0;
  const provider = mediaApiProvider(preset, (async () => {
    calls++;
    return Response.json({ data: [{ url: "https://ideogram.ai.untrusted.invalid/image.png" }] });
  }) as typeof fetch);
  await expect(
    provider.submit(
      { baseUrl: preset.baseUrl, apiKey: "fixture-key" },
      { id: randomUUID(), kind: "image", model: "ideogram-4-6", prompt },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "invalidResult" });
  expect(calls).toBe(1);
});
