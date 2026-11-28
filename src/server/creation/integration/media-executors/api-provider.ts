import { isRecord } from "../../../../shared/records.js";
import { MediaExecutorError, type MediaConnection, type MediaProvider } from "../../media-executors/contracts.js";
import type { ApiMediaPreset } from "./presets.js";

const imageLimit = 32 * 1024 * 1024;
const imagePayloadLimit = Math.ceil(imageLimit / 3) * 4 + 65536;
const videoLimit = 32 * 1024 * 1024;
const taskPattern = /^[a-z\d][a-z\d_-]{0,159}$/i;

function remoteError(status: number, submission: boolean) {
  if (status === 401 || status === 403) return new MediaExecutorError("authentication");
  if (status === 429) return new MediaExecutorError("rateLimited");
  if (status >= 500) return new MediaExecutorError(submission ? "uncertain" : "unavailable");
  return new MediaExecutorError(status === 404 ? "notFound" : "failed");
}

async function responseBytes(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > limit)
    throw new MediaExecutorError("invalidResult");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new MediaExecutorError("invalidResult");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!size) throw new MediaExecutorError("invalidResult");
  return Buffer.concat(chunks, size);
}

function record(value: unknown) {
  if (!isRecord(value)) throw new MediaExecutorError("invalidResult");
  return value;
}

function imageBytes(value: unknown) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(imageLimit / 3) * 4)
    throw new MediaExecutorError("invalidResult");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > imageLimit || bytes.toString("base64") !== value)
    throw new MediaExecutorError("invalidResult");
  return bytes;
}

async function payload(response: Response, limit: number) {
  try {
    return record(JSON.parse((await responseBytes(response, limit)).toString("utf8")));
  } catch {
    throw new MediaExecutorError("invalidResult");
  }
}

function first(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new MediaExecutorError("invalidResult");
  return record(value[0]);
}

function providerHeaders(preset: ApiMediaPreset, apiKey: string): HeadersInit {
  switch (preset.provider) {
    case "google":
      return { "x-goog-api-key": apiKey };
    case "black-forest-labs":
      return { "x-key": apiKey };
    case "ideogram":
      return { "Api-Key": apiKey };
    case "fal":
      return { Authorization: "Key " + apiKey };
    default:
      return { Authorization: "Bearer " + apiKey };
  }
}

const fluxApiHost = /^api(?:\.((?:eu|us)\d{0,3}))?\.bfl\.ai$/;
const fluxDeliveryHost = /^delivery[.-][a-z]{2}\d{1,3}\.bfl\.ai$/;

function fluxTaskId(id: unknown, pollingUrl: unknown) {
  try {
    if (typeof id !== "string" || typeof pollingUrl !== "string" || pollingUrl.length > 1024) throw Error();
    const url = new URL(pollingUrl);
    const host = fluxApiHost.exec(url.hostname);
    const task = (host?.[1] ?? "global") + "_" + id;
    if (
      !host ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.pathname !== "/v1/get_result" ||
      url.search !== "?id=" + id ||
      !taskPattern.test(id) ||
      !taskPattern.test(task)
    )
      throw Error();
    return task;
  } catch {
    throw new MediaExecutorError("uncertain");
  }
}

export function mediaApiProvider(preset: ApiMediaPreset, send: typeof fetch = fetch): MediaProvider {
  const seedance = preset.id === "seedance-video",
    openai = preset.id === "openai-image",
    grok = preset.id === "grok-image";
  async function request(
    connection: MediaConnection,
    path: string,
    signal: AbortSignal,
    body?: object,
    options: { accept?: string; baseUrl?: string } = {},
  ) {
    signal.throwIfAborted();
    let response: Response;
    try {
      const multipart = body instanceof FormData;
      response = await send((options.baseUrl ?? connection.baseUrl) + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...providerHeaders(preset, connection.apiKey),
          ...(body && !multipart ? { "content-type": "application/json" } : {}),
          ...(options.accept ? { accept: options.accept } : {}),
        },
        ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new MediaExecutorError(body ? "uncertain" : "unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw remoteError(response.status, !!body);
    }
    return response;
  }
  async function download(value: unknown, signal: AbortSignal, limit: number) {
    let url: URL;
    try {
      if (typeof value !== "string" || value.length > 8192) throw Error();
      url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        (!preset.downloadHosts.includes(url.hostname) &&
          !(preset.provider === "black-forest-labs" && fluxDeliveryHost.test(url.hostname)))
      )
        throw Error();
    } catch {
      throw new MediaExecutorError("invalidResult");
    }
    const response = await send(url, { redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw remoteError(response.status, false);
    }
    return responseBytes(response, limit);
  }
  async function generateImage(
    connection: MediaConnection,
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    switch (preset.provider) {
      case "stability": {
        const form = new FormData();
        form.set("prompt", prompt);
        form.set("output_format", "png");
        const diffusion = model.startsWith("sd3.");
        if (diffusion) form.set("model", model);
        const response = await request(
          connection,
          "/v2beta/stable-image/generate/" + (diffusion ? "sd3" : model),
          signal,
          form,
          {
            accept: "image/*",
          },
        );
        if (response.headers.get("finish-reason")?.toLowerCase() === "content_filtered") {
          await response.body?.cancel().catch(() => {});
          throw new MediaExecutorError("failed");
        }
        return responseBytes(response, imageLimit);
      }
      case "google": {
        const response = await request(connection, "/interactions", signal, {
          model,
          input: [{ type: "text", text: prompt }],
          store: false,
          response_format: { type: "image" },
        });
        const { steps } = await payload(response, imagePayloadLimit);
        const outputs = Array.isArray(steps)
          ? steps.flatMap((step) =>
              isRecord(step) && step.type === "model_output" && Array.isArray(step.content) ? step.content : [],
            )
          : [];
        return imageBytes(record(outputs.find((item) => isRecord(item) && item.type === "image")).data);
      }
      case "ideogram": {
        const response = await request(connection, "/image/generate/" + model, signal, { prompt, num_images: 1 });
        const { data } = await payload(response, 65536);
        const image = first(data);
        if (image.is_image_safe === false) throw new MediaExecutorError("failed");
        return download(image.url, signal, imageLimit);
      }
      case "alibaba-cloud": {
        const response = await request(connection, "/services/aigc/multimodal-generation/generation", signal, {
          model,
          input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
          parameters: { size: "2K", n: 1 },
        });
        const { output } = await payload(response, 65536);
        const { content } = record(first(record(output).choices).message);
        const image = Array.isArray(content)
          ? content.find((part) => isRecord(part) && typeof part.image === "string")
          : undefined;
        return download(record(image).image, signal, imageLimit);
      }
      case "fal": {
        const response = await request(connection, "/" + model, signal, { prompt, num_images: 1, sync_mode: true });
        const { images } = await payload(response, imagePayloadLimit);
        const { url } = first(images);
        const encoded = typeof url === "string" && /^data:image\/(?:png|jpeg|webp);base64,/.test(url);
        return encoded ? imageBytes(url.slice(url.indexOf(",") + 1)) : download(url, signal, imageLimit);
      }
      default:
        throw new MediaExecutorError("invalidInput");
    }
  }

  return {
    async check(connection, signal, modelId = preset.models[0]!.id) {
      if (seedance) {
        const response = await request(connection, "/contents/generations/tasks?page_size=1", signal);
        await response.body?.cancel().catch(() => {});
        // The task list authenticates the key but does not prove generation access for a model.
        return "unverified";
      }
      if (preset.provider === "ideogram") {
        const response = await request(connection, "/image/generate/" + modelId + "?dry_run=true", signal, {
          prompt: "A white square on a navy background.",
          num_images: 1,
        });
        await response.body?.cancel().catch(() => {});
        return "connected";
      }
      if (preset.provider === "recraft") {
        const response = await request(connection, "/users/me", signal);
        await response.body?.cancel().catch(() => {});
        return "unverified";
      }
      if (preset.provider !== "openai" && preset.provider !== "google" && !grok) return "unverified";
      const model = encodeURIComponent(modelId);
      const response = await request(connection, (grok ? "/image-generation-models/" : "/models/") + model, signal);
      await response.body?.cancel().catch(() => {});
      return "connected";
    },
    async submit(connection, input, signal) {
      if (input.kind !== preset.kind || !preset.models.some((model) => model.id === input.model))
        throw new MediaExecutorError("invalidInput");
      if (seedance) {
        const response = await request(connection, "/contents/generations/tasks", signal, {
          model: input.model,
          content: [{ type: "text", text: input.prompt }],
          resolution: "480p",
          duration: 5,
          ratio: "16:9",
          watermark: true,
        });
        const { id } = await payload(response, 65536).catch(() => {
          throw new MediaExecutorError("uncertain");
        });
        if (typeof id !== "string" || !taskPattern.test(id)) throw new MediaExecutorError("uncertain");
        return { state: "pending", taskId: id };
      }
      if (preset.provider === "black-forest-labs") {
        const response = await request(connection, "/" + input.model, signal, {
          prompt: input.prompt,
          width: 1024,
          height: 1024,
          output_format: "png",
        });
        const reply = await payload(response, 65536).catch(() => {
          throw new MediaExecutorError("uncertain");
        });
        return { state: "pending", taskId: fluxTaskId(reply.id, reply.polling_url) };
      }
      const recraft = preset.provider === "recraft";
      const seedream = preset.id === "seedream-image";
      if (!openai && !grok && !recraft && !seedream && preset.provider !== "zhipu")
        return { state: "succeeded", bytes: await generateImage(connection, input.model, input.prompt, signal) };
      const response = await request(connection, "/images/generations", signal, {
        prompt: input.prompt,
        model: input.model,
        ...(grok || recraft || seedream ? { response_format: "b64_json" } : {}),
        ...(recraft ? { image_format: "png" } : {}),
        ...(seedream ? { stream: false, size: "2K" } : {}),
      });
      const { data } = await payload(response, imagePayloadLimit);
      if (!Array.isArray(data) || data.length !== 1) throw new MediaExecutorError("invalidResult");
      const item = record(data[0]);
      const bytes =
        openai || grok || recraft || seedream
          ? imageBytes(item.b64_json)
          : await download(item.url, signal, imageLimit);
      const invocation = response.headers.get("x-request-id");
      return {
        state: "succeeded",
        bytes,
        ...(invocation && taskPattern.test(invocation) ? { invocationId: invocation } : {}),
      };
    },
    ...(preset.provider === "black-forest-labs"
      ? {
          async poll(connection: MediaConnection, taskId: string, signal: AbortSignal) {
            const task = /^(global|(?:eu|us)\d{0,3})_([a-z\d][a-z\d_-]*)$/i.exec(taskId);
            if (!task || !taskPattern.test(taskId)) throw new MediaExecutorError("invalidInput");
            const [, region, id] = task;
            const host = region === "global" ? "api.bfl.ai" : "api." + region + ".bfl.ai";
            const response = await request(connection, "/get_result?id=" + id, signal, undefined, {
              baseUrl: "https://" + host + "/v1",
            });
            const reply = await payload(response, 65536);
            if (reply.id !== id) throw new MediaExecutorError("invalidResult");
            if (["Pending", "Reasoning", "Generating"].includes(String(reply.status)))
              return { state: "pending" as const, taskId };
            if (
              ["Error", "Task not found", "Request Moderated", "Content Moderated", "No Card Generated"].includes(
                String(reply.status),
              )
            )
              return { state: "failed" as const };
            if (reply.status !== "Ready") throw new MediaExecutorError("invalidResult");
            const bytes = await download(record(reply.result).sample, signal, imageLimit);
            return { state: "succeeded" as const, bytes, invocationId: id };
          },
        }
      : {}),
    ...(seedance
      ? {
          async poll(connection: MediaConnection, taskId: string, signal: AbortSignal) {
            if (!taskPattern.test(taskId)) throw new MediaExecutorError("invalidInput");
            const reply = await payload(
              await request(connection, "/contents/generations/tasks/" + taskId, signal),
              65536,
            );
            if (reply.id !== taskId) throw new MediaExecutorError("invalidResult");
            if (["failed", "cancelled", "expired"].includes(String(reply.status))) return { state: "failed" as const };
            if (reply.status === "queued" || reply.status === "running") return { state: "pending" as const, taskId };
            if (reply.status !== "succeeded") throw new MediaExecutorError("invalidResult");
            const bytes = await download(record(reply.content).video_url, signal, videoLimit);
            return { state: "succeeded" as const, bytes, invocationId: taskId };
          },
        }
      : {}),
  };
}
