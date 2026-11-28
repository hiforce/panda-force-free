import sharp from "sharp";
import { NativePresentation } from "../../slides/office/package.js";
import type { NativeSlideShape } from "../../../shared/slides/contracts.js";
import { MediaExecutorError } from "../media-executors/contracts.js";
import type { CreationMediaJobs } from "./media-executors/jobs.js";
import { creativeKindMatchesName } from "../../../shared/creative/file-types.js";
import { isRecord } from "../../../shared/records.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { ApplicationToolDefinition } from "../../../shared/engine/application-tools.js";
import type { CreationRendering } from "../runtime/rendering.js";
import type { CreationOutputs } from "../outputs.js";
import type { CreationMessages } from "../messages/service.js";
import type { CreationMaterialPort } from "../materials.js";
import type { CreationOutputTasks } from "../ports.js";
import { CreationError, CreationWriteError } from "../contracts.js";
import { DocumentError } from "../../documents/errors.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../validation.js";
import { creationPrompt } from "../input-values.js";
import type { CreationAssetAccess } from "./media-output.js";
import { renderedCreationOutput } from "./typed-output.js";
import { ImageRenderJournal, imageRenderIntent } from "./rendering/image-journal.js";
import { ImageRenderError, type ImageRenderIntent, type ImageRenderRequest } from "./rendering/image-contracts.js";
import { decodedImage, imageDigest } from "./rendering/image-result.js";
import type { ApplicationImageRenderer, ApplicationRuntimePort } from "../../engines/application-tools/runtime-port.js";
import type { HarnessRuntimeView } from "../../../shared/harness/contracts.js";
import { harnessCreationCapabilities } from "../../harness/creation-capabilities.js";
import {
  CreationCandidateChanged,
  type CreationGeneratedOriginals,
  type GeneratedKind,
} from "./rendering/generated-originals.js";
import type { CreationArtifactGenerator } from "./rendering/generators.js";
import { creationRenderSlots, RenderingBusyError } from "./rendering/slots.js";
import {
  CreationOriginalSources,
  CreationOriginalError,
  originalReadDefinition,
  ORIGINAL_READ_TOOL,
} from "./rendering/original-source.js";
import { OfficePresentationError } from "../../../shared/slides/contracts.js";

export const RENDER_IMAGE_TOOL = "panda_images_render";
export const SAVE_ARTIFACT_TOOL = "panda_artifacts_save";
export const IMPORT_ARTIFACT_TOOL = "panda_artifacts_import_file";
const MEDIA_JOB_STATUS_TOOL = "panda_media_job_status";
const mediaJobStatusDefinition: ApplicationToolDefinition = {
  name: MEDIA_JOB_STATUS_TOOL,
  description:
    "Look up an executor job ID returned by this creation's image or video tool. This reads the existing job without requesting generation. Ready means the original is available to this creation. Use the same rendering slot and arguments to retrieve its asset handle, then save it explicitly. A locally stopped job may still exist at the provider. Ask the user before submitting a replacement.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["jobId"],
    properties: { jobId: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  },
};
const nativeArtifactKinds = ["image", "slides", "video", "web"] as const;
const importDefinition: ApplicationToolDefinition = {
  name: IMPORT_ARTIFACT_TOOL,
  description:
    "Save one finished image, presentation, video or HTML file produced by this Harness in its current workspace. Supply just the filename and the actual artifact kind. This preserves the native original and returns its saved receipt.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "filename", "title"],
    properties: {
      kind: { type: "string", enum: nativeArtifactKinds },
      filename: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
};
const definitions: ApplicationToolDefinition[] = [
  {
    name: RENDER_IMAGE_TOOL,
    description:
      "Generate or edit one finished raster image using this task's selected image source. Read all current context first. Use a detailed prompt covering the user's actual subject, labels, composition and style. slot is a stable choice from 1 to 8: retry the same slot and unchanged prompt to recover the same result without new inference; use a new slot only for a deliberate new candidate. Optional materialIds are images explicitly provided to this task, listed by panda_creation_context. No arbitrary files, paths or URLs. The returned handle belongs only to this task. Inspect the returned image, then save the chosen result with panda_artifacts_save; rendering alone does not complete this task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slot", "prompt"],
      properties: {
        slot: { type: "integer", minimum: 1, maximum: 8 },
        prompt: { type: "string", minLength: 1, maxLength: 65536 },
        materialIds: { type: "array", maxItems: 2, uniqueItems: true, items: { type: "string" } },
        previousImage: {
          type: "boolean",
          description:
            "Use this continuation's authorized previous image as an editing reference. The original remains saved.",
        },
      },
    },
  },
  {
    name: SAVE_ARTIFACT_TOOL,
    description:
      "Save a finished image rendered by panda_images_render as this task's primary artifact. Supply its owned handle and a concise title. Read current context first and apply all updates. This saves the actual original and returns its real artifact receipt; repeating the call returns the same receipt. Never substitute a design brief, prompt or document for the image. The application selects project, identity, filename and permissions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "handle", "title"],
      properties: {
        kind: { type: "string", const: "image" },
        handle: { type: "string", pattern: "^[a-f0-9]{64}$" },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
];
async function renderApplicationImage(
  journal: ImageRenderJournal,
  renderer: ApplicationImageRenderer,
  intent: ImageRenderIntent,
  images: readonly Uint8Array[],
  signal: AbortSignal,
  authorize: () => Promise<void>,
) {
  if (images.some((bytes) => bytes.length > renderer.maxReferenceBytes)) throw new ImageRenderError("invalidInput");
  await journal.insert(intent, "intent", intent);
  const saved = await journal.receipt(intent);
  if (saved) return saved;
  await authorize();
  signal.throwIfAborted();
  if (!(await journal.insert(intent, "dispatch", { provider: renderer.provider }))) {
    const existing = await journal.receipt(intent);
    if (existing) return existing;
    throw new ImageRenderError("uncertain");
  }
  await authorize();
  signal.throwIfAborted();
  const output = await renderer
    .render(
      intent.prompt,
      images.map((bytes, i) => ({ bytes, mime: intent.inputs[i]!.mime })),
      signal,
    )
    .catch(() => {
      throw new ImageRenderError("unavailable");
    });
  await authorize();
  signal.throwIfAborted();
  return journal.save(intent, output.bytes, {
    provider: renderer.provider,
    ...(output.invocationId ? { invocationId: output.invocationId } : {}),
    size: output.bytes.length,
    digest: imageDigest(output.bytes),
    ...(await decodedImage(output.bytes)),
  });
}

function hasIllustration(shapes: readonly NativeSlideShape[]): boolean {
  return shapes.some((shape) => shape.kind === "picture" || hasIllustration(shape.children));
}

/** The main model receives only task-scoped render handles; provider identities and private paths stay server-side. */
export function creationImageTools(options: {
  journal: ImageRenderJournal;
  renderer: {
    render: (
      request: ImageRenderRequest,
      callbacks: { signal: AbortSignal; authorize(): Promise<void> },
    ) => Promise<{ bytes: Buffer; width: number; height: number; mime: string }>;
  };
  outputs: Pick<CreationOutputs, "invoke">;
  tasks: Pick<CreationOutputTasks, "get">;
  available(): Promise<boolean>;
  applicationImages?: Pick<ApplicationRuntimePort, "creationImage" | "hasCreationImage"> &
    Partial<Pick<ApplicationRuntimePort, "discover">>;
  mediaJobs?: CreationMediaJobs;
  materials?: CreationMaterialPort;
  messages?: Pick<CreationMessages, "context">;
  assets: CreationAssetAccess;
  generated?: CreationGeneratedOriginals;
  generators?: readonly CreationArtifactGenerator[];
}): CreationRendering {
  const installedGenerators = options.generators ?? [],
    kinds = [...new Set(["image", ...installedGenerators.map((g) => g.kind), ...(options.mediaJobs ? ["video"] : [])])];
  const primaryDefinitions = structuredClone(definitions);
  primaryDefinitions[1]!.description =
    "Save this task's finished rendered artifact using its owned handle, true kind and concise title. This persists the original and returns a real receipt. Repeat calls return the same primary. Project, identity, filename and permissions belong to the application. Rendering alone is not a saved artifact; never substitute a brief, outline or script.";
  (primaryDefinitions[1]!.inputSchema.properties as Record<string, unknown>).kind = { type: "string", enum: kinds };
  const capabilities = (owner: string, runtime: HarnessRuntimeView, model?: string) =>
    harnessCreationCapabilities(
      runtime,
      async () => {
        if (runtime.id === "codex" && runtime.profileId === "codex") return options.available();
        const plugin = await options.applicationImages?.creationImage?.(owner, runtime.id);
        return plugin?.version ? plugin.version() : false;
      },
      model,
    );
  async function nativeImage(owner: string, runtimeId: string, model: string) {
    try {
      const runtime = await options.applicationImages?.discover?.(owner, runtimeId, "creation");
      return !!runtime && (await capabilities(owner, runtime, model)).nativeImage;
    } catch {
      return false;
    }
  }
  return {
    capabilities,
    nativeImage,
    async available() {
      const [image, available] = await Promise.all([
        !!options.mediaJobs ||
          options.applicationImages?.hasCreationImage?.() ||
          options.available().catch(() => false),
        Promise.all(
          installedGenerators.map(async (g) =>
            !g.available || (await g.available().catch(() => false)) ? [g.kind] : [],
          ),
        ),
      ]);
      return [
        ...new Set([
          ...(image ? ["image" as const] : []),
          ...available.flat(),
          ...(options.mediaJobs ? ["video" as const] : []),
        ]),
      ];
    },
    async open(context) {
      const task = context.task,
        profile = context.input.profile,
        media = context.input.media,
        chosenExecutor = media?.source === "executor" ? media : undefined,
        mediaScope = {
          owner: task.owner,
          creationId: task.id,
          projectId: task.projectId,
          inputDigest: task.inputDigest,
        },
        externalImage = chosenExecutor?.kind === "image" ? chosenExecutor : undefined,
        externalVideo = chosenExecutor?.kind === "video" ? chosenExecutor : undefined,
        nativeAllowed = !context.input.mediaPolicy || (media?.kind === "image" && media.source === "harness"),
        needsIllustrations = task.kind === "slides" && media?.kind === "image",
        usesPrimaryRenderer =
          nativeAllowed && profile.engineId === "codex" && (!profile.runtimeId || profile.runtimeId === "codex"),
        applicationImage =
          nativeAllowed && task.kind !== "document" && !usesPrimaryRenderer && profile.runtimeId
            ? await options.applicationImages?.creationImage?.(task.owner, profile.runtimeId).catch(() => undefined)
            : undefined;
      const explicitNative = media?.kind === "image" && media.source === "harness";
      const renderDefinitions = structuredClone(
        primaryDefinitions.filter(
          (tool) =>
            tool.name !== RENDER_IMAGE_TOOL ||
            usesPrimaryRenderer ||
            applicationImage ||
            externalImage ||
            explicitNative,
        ),
      );
      if (applicationImage || externalImage) {
        const render = renderDefinitions.find((tool) => tool.name === RENDER_IMAGE_TOOL)!;
        const properties = render.inputSchema.properties as { materialIds: { maxItems: number } };
        properties.materialIds.maxItems = applicationImage?.maxReferences ?? 0;
        const maxMiB = (applicationImage?.maxReferenceBytes ?? 0) / (1024 * 1024);
        render.description += applicationImage?.maxReferences
          ? ` Reference image limit: ${applicationImage.maxReferences} total, each up to ${maxMiB} MiB.`
          : " This renderer generates from text. Omit materialIds and previousImage.";
        if (externalImage) render.description += " If this call returns a jobId, panda_media_job_status can query it.";
      }
      const generators = externalVideo
        ? [
            ...installedGenerators.filter((generator) => generator.kind !== "video"),
            {
              kind: "video" as const,
              definition: {
                name: "panda_videos_generate",
                description:
                  "Generate one video from text with this task's selected video executor. Use the same slot and prompt to resume. If this call returns a jobId, panda_media_job_status can query it. Save the completed handle with panda_artifacts_save as kind:video.",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slot", "prompt"],
                  properties: {
                    slot: { type: "integer", minimum: 1, maximum: 8 },
                    prompt: { type: "string", minLength: 1, maxLength: 65536 },
                  },
                },
              },
            },
          ]
        : installedGenerators;
      const sources = new CreationOriginalSources(
        context.input,
        options.assets,
        async () => {
          const materials = new Map((context.input.materials ?? []).map((m) => [m.id, m]));
          for (const update of (await options.messages?.context(task.owner, task.id)) ?? [])
            for (const material of update.payload.materials) materials.set(material.id, material);
          return [...materials.values()];
        },
        options.materials,
      );
      return {
        definitions:
          task.kind === "document"
            ? context.input.previousAsset
              ? [structuredClone(originalReadDefinition)]
              : []
            : [
                ...renderDefinitions,
                ...(chosenExecutor && options.mediaJobs ? [structuredClone(mediaJobStatusDefinition)] : []),
                ...(options.generated && context.readNativeFile ? [structuredClone(importDefinition)] : []),
                structuredClone(originalReadDefinition),
                ...generators
                  .filter((g) => task.kind === "auto" || task.kind === g.kind)
                  .map((g) => structuredClone(g.definition)),
              ],
        async call(value) {
          const call = structuredClone(value);
          const bound = context.execution(call);
          let mediaJobId: string | undefined;
          context.signal.throwIfAborted();
          try {
            if (call.name === MEDIA_JOB_STATUS_TOOL) {
              await context.assert(call);
              if (!chosenExecutor || !options.mediaJobs) throw new CreationError("unavailable");
              const args = creationRecord(call.arguments, ["jobId"]);
              const jobId = creationDigest(args.jobId);
              const state = await options.mediaJobs.status({ ...mediaScope, binding: chosenExecutor }, jobId);
              await context.active(call);
              return { success: true, text: stableJson({ jobId, state }) };
            }
            if (call.name === SAVE_ARTIFACT_TOOL || call.name === IMPORT_ARTIFACT_TOOL) {
              const current = await options.tasks.get(task.owner, task.id);
              if (current.generation !== bound.generation) throw new CreationError("leaseLost");
              if (current.artifact) return { success: true, text: stableJson(current.artifact) };
              const execution = await context.assert(call),
                importing = call.name === IMPORT_ARTIFACT_TOOL,
                args = creationRecord(call.arguments, ["kind", importing ? "filename" : "handle", "title"]),
                title = creationText(args.title, 200),
                kind = args.kind as "image" | GeneratedKind;
              if (task.kind !== "auto" && task.kind !== kind) throw new CreationError("invalidOutput");
              if (context.input.mediaPolicy && !media && (kind === "slides" || kind === "image"))
                return {
                  success: false,
                  text: stableJson({
                    error: "unavailable",
                    saved: false,
                    action:
                      "Ask the user to select the image or presentation output and an image executor before continuing.",
                  }),
                };
              let handle: string;
              if (importing) {
                if (
                  (media?.kind === "image" && (kind === "image" || kind === "slides")) ||
                  (externalVideo && kind === "video")
                )
                  throw new CreationError("invalidOutput");
                const name = creationText(args.filename, 200);
                if (
                  !options.generated ||
                  !context.readNativeFile ||
                  !nativeArtifactKinds.includes(kind) ||
                  !creativeKindMatchesName(kind, name)
                )
                  throw new CreationError("invalidInput");
                const bytes = await context.readNativeFile(name).catch(() => {
                  throw new CreationError("invalidOutput");
                });
                const signature = imageDigest(stableJson({ name, digest: imageDigest(bytes) }));
                handle = await options.generated.render(
                  {
                    owner: task.owner,
                    taskId: task.id,
                    kind,
                    slot: 1,
                    signature,
                    contextDigest: imageDigest(
                      stableJson({ purpose: "native-creation-output", input: task.inputDigest, signature }),
                    ),
                  },
                  async () => ({ kind, name, bytes }),
                  () => context.active(call),
                );
              } else {
                if (!kinds.includes(String(kind))) throw new CreationError("invalidOutput");
                handle = creationDigest(args.handle);
              }
              if (needsIllustrations) {
                if (importing && !context.input.previousAsset) throw new CreationError("invalidOutput");
                const original = await options.generated?.resolve(task.owner, task.id, "slides", handle);
                if (!original) throw new CreationError("invalidOutput");
                const presentation = await NativePresentation.open(original.bytes, original.source.name);
                if (!presentation.index.slides.some((entry) => hasIllustration(presentation.part(entry.path).shapes)))
                  return {
                    success: false,
                    text: stableJson({
                      error: "invalidOutput",
                      saved: false,
                      action: "Generate and embed a picture before saving the presentation.",
                    }),
                  };
              }
              const saved = await options.outputs.invoke(
                execution,
                renderedCreationOutput({
                  owner: task.owner,
                  taskId: task.id,
                  kind,
                  handle,
                  title,
                  ...(importing ? { origin: "native" } : {}),
                }),
              );
              if (!saved.artifact) throw new CreationError("unavailable");
              return { success: true, text: stableJson(saved.artifact) };
            }
            return await creationRenderSlots.run(context.signal, async () => {
              if (call.name === ORIGINAL_READ_TOOL) {
                await context.assert(call);
                const result = await sources.read(call.arguments);
                await context.active(call);
                return result;
              }
              const generator = generators.find((g) => g.definition.name === call.name);
              if (generator) {
                const execution = await context.assert(call);
                if (
                  !options.generated ||
                  ("available" in generator && generator.available && !(await generator.available()))
                )
                  throw new CreationError("unavailable");
                const args = creationRecord(
                  call.arguments,
                  Object.keys(generator.definition.inputSchema.properties as object),
                );
                if (
                  needsIllustrations &&
                  generator.definition.name === "panda_slides_render" &&
                  (!Array.isArray(args.pages) ||
                    !args.pages.some((page) => isRecord(page) && page.layout === "picture"))
                )
                  throw new CreationError("invalidOutput");
                const videoRequest =
                  externalVideo && generator.definition.name === "panda_videos_generate"
                    ? {
                        scope: { ...mediaScope, binding: externalVideo },
                        callId: imageDigest(stableJson({ task: task.id, input: task.inputDigest, slot: args.slot })),
                        prompt: creationPrompt(args.prompt),
                      }
                    : undefined;
                const key = await options.generated.render(
                  {
                    owner: task.owner,
                    taskId: task.id,
                    kind: generator.kind,
                    contextDigest: imageDigest(
                      stableJson({
                        input: task.inputDigest,
                        context: execution.contextVersion ?? null,
                        goal: execution.goalVersion ?? null,
                      }),
                    ),
                    slot: creationInteger(args.slot),
                    signature: imageDigest(stableJson(args)),
                  },
                  async () => {
                    if (videoRequest) {
                      if (!options.mediaJobs) throw new MediaExecutorError("unavailable");
                      const video = await options.mediaJobs.run(
                        videoRequest.scope,
                        videoRequest.callId,
                        videoRequest.prompt,
                        context.signal,
                        () => context.active(call),
                        (jobId) => (mediaJobId = jobId),
                      );
                      return { kind: "video", name: "generated.mp4", bytes: video.bytes };
                    }
                    if (!("render" in generator)) throw new CreationError("unavailable");
                    return generator.render(args, {
                      signal: context.signal,
                      sources,
                      authorize: () => context.active(call),
                      image: async (handle) =>
                        (await options.journal.resolve(task.owner, task.id, handle)).receipt.bytes,
                    });
                  },
                  () => context.active(call),
                );
                if (videoRequest && !mediaJobId)
                  mediaJobId = await options.mediaJobs?.existingId(
                    videoRequest.scope,
                    videoRequest.callId,
                    videoRequest.prompt,
                  );
                await context.active(call);
                return {
                  success: true,
                  text: stableJson({
                    handle: key,
                    kind: generator.kind,
                    ...("mode" in generator && generator.mode ? { renderingMode: generator.mode } : {}),
                    ...(mediaJobId ? { jobId: mediaJobId } : {}),
                    saved: false,
                  }),
                };
              }
              if (call.name !== RENDER_IMAGE_TOOL) throw new CreationError("invalidInput");
              const execution = await context.assert(call);
              if (
                !explicitNative &&
                !applicationImage &&
                !externalImage &&
                (!usesPrimaryRenderer || !(await options.available()))
              )
                throw new CreationError("unavailable");
              const args = creationRecord(call.arguments, ["slot", "prompt", "materialIds", "previousImage"]),
                updates = (await options.messages?.context(task.owner, task.id)) ?? [],
                materials = new Map((context.input.materials ?? []).map((m) => [m.id, m]));
              for (const update of updates)
                for (const material of update.payload.materials) materials.set(material.id, material);
              const rawIds = args.materialIds ?? [];
              if (
                !Array.isArray(rawIds) ||
                rawIds.length > 2 ||
                (args.previousImage !== undefined && typeof args.previousImage !== "boolean") ||
                rawIds.length + (args.previousImage ? 1 : 0) >
                  (externalImage ? 0 : (applicationImage?.maxReferences ?? 2))
              )
                throw new CreationError("invalidInput");
              const ids = rawIds.map(creationUuid);
              if (new Set(ids).size !== ids.length) throw new CreationError("invalidInput");
              const images: Uint8Array[] = [];
              if (args.previousImage) {
                const previous = context.input.previousAsset?.artifact;
                if (!previous || previous.kind !== "image") throw new CreationError("notFound");
                const source = await (
                  await options.assets(task.owner, previous.projectId)
                )
                  .original(previous.projectId, previous.assetId)
                  .catch((error) => {
                    throw new CreationWriteError(
                      error instanceof DocumentError && error.code === "notFound"
                        ? "targetChanged"
                        : "writeUnavailable",
                      error,
                    );
                  });
                if (source.asset.version !== previous.version || source.asset.source.digest !== previous.source.digest)
                  throw new CreationWriteError("targetChanged", new CreationError("conflict"));
                images.push(
                  source.bytes.length <= 8 * 1024 * 1024
                    ? source.bytes
                    : await sharp(source.bytes, { limitInputPixels: 40_000_000 })
                        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
                        .png()
                        .toBuffer(),
                );
              }
              for (const id of ids) {
                const material = materials.get(id);
                if (!options.materials || !material || material.kind !== "image") throw new CreationError("notFound");
                const source = await options.materials.read(task.owner, material, 0, task.target.locale),
                  data = source.images?.[0],
                  match = data?.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/);
                if (!source.success || source.images?.length !== 1 || !match || match[1]!.length > 12000000)
                  throw new CreationError("invalidInput");
                images.push(Buffer.from(match[1]!, "base64"));
              }
              const request: ImageRenderRequest = {
                  owner: task.owner,
                  taskId: task.id,
                  contextDigest: imageDigest(
                    stableJson({
                      input: task.inputDigest,
                      context: execution.contextVersion ?? null,
                      goal: execution.goalVersion ?? null,
                    }),
                  ),
                  slot: creationInteger(args.slot),
                  prompt: creationPrompt(args.prompt),
                  profile:
                    usesPrimaryRenderer && profile.media
                      ? { id: "codex", engineId: "codex", ...profile.media }
                      : profile,
                  images,
                },
                intent = await imageRenderIntent(request);
              await context.assert(call);
              const nativeReceipt = explicitNative ? await options.journal.receipt(intent) : null;
              if (
                explicitNative &&
                !nativeReceipt &&
                (!profile.model ||
                  (!usesPrimaryRenderer && !applicationImage) ||
                  !(await nativeImage(task.owner, profile.runtimeId ?? "codex", profile.model)))
              )
                throw new ImageRenderError("unavailable");
              const result =
                nativeReceipt ??
                (externalImage
                  ? await (async () => {
                      await options.journal.insert(intent, "intent", intent);
                      const existing = await options.journal.receipt(intent);
                      if (existing) {
                        mediaJobId = await options.mediaJobs?.existingId(
                          { ...mediaScope, binding: externalImage },
                          intent.key,
                          intent.prompt,
                        );
                        return existing;
                      }
                      if (!options.mediaJobs) throw new MediaExecutorError("unavailable");
                      const output = await options.mediaJobs.run(
                        { ...mediaScope, binding: externalImage },
                        intent.key,
                        intent.prompt,
                        context.signal,
                        () => context.active(call),
                        (jobId) => (mediaJobId = jobId),
                      );
                      return options.journal.save(intent, output.bytes, {
                        provider: "media-executor",
                        ...(output.invocationId ? { invocationId: output.invocationId } : {}),
                        size: output.bytes.length,
                        digest: imageDigest(output.bytes),
                        ...(await decodedImage(output.bytes)),
                      });
                    })()
                  : applicationImage
                    ? await renderApplicationImage(
                        options.journal,
                        applicationImage,
                        intent,
                        images,
                        context.signal,
                        () => context.active(call),
                      )
                    : await options.renderer.render(request, {
                        signal: context.signal,
                        authorize: () => context.active(call),
                      }));
              await context.active(call);
              const preview = await sharp(result.bytes, { limitInputPixels: 40_000_000 })
                .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
                .webp({ quality: 88 })
                .toBuffer();
              return {
                success: true,
                text: stableJson({
                  handle: intent.key,
                  kind: "image",
                  width: result.width,
                  height: result.height,
                  ...(mediaJobId ? { jobId: mediaJobId } : {}),
                  saved: false,
                }),
                images: ["data:image/webp;base64," + preview.toString("base64")],
              };
            });
          } catch (error) {
            if (error instanceof MediaExecutorError)
              return {
                success: false,
                text: stableJson({ error: error.code, saved: false, ...(mediaJobId ? { jobId: mediaJobId } : {}) }),
              };
            if (error instanceof OfficePresentationError)
              return {
                success: false,
                text: stableJson({
                  error: "unsupportedSource",
                  saved: false,
                  action:
                    "The supplied presentation or native edit cannot be processed safely by this renderer. Explain the actual limitation; request a supported original or explicit permission to redesign it instead. Do not claim the edit was saved.",
                }),
              };
            if (error instanceof CreationCandidateChanged)
              return {
                success: false,
                text: stableJson({
                  error: "candidateChanged",
                  saved: false,
                  action:
                    "This slot already belongs to different rendering input. Reconcile it with the original unchanged arguments, or choose an unused slot for the corrected or revised candidate.",
                }),
              };
            if (error instanceof CreationOriginalError)
              return {
                success: false,
                text: stableJson({
                  error: error.code,
                  saved: false,
                  action:
                    error.code === "originalNotRead"
                      ? "Read the authorized original using panda_creation_original_read, following every nextOffset for each page to edit. Use only returned sourceId and slot references, then retry the same rendering input."
                      : "This original type cannot be edited by this tool. Do not claim a finished edit or substitute a planning document.",
                }),
              };
            if (error instanceof RenderingBusyError)
              return {
                success: false,
                text: stableJson({
                  error: "busy",
                  retryable: true,
                  action:
                    "Retry the same slot and unchanged input after the active render finishes. No primary artifact has been saved.",
                }),
              };
            if (error instanceof DocumentError && call.name === IMPORT_ARTIFACT_TOOL)
              return {
                success: false,
                text: stableJson({
                  error: "invalidOutput",
                  saved: false,
                  action:
                    "Use a valid finished file with the expected format. Only an original file in this run's workspace can be saved.",
                }),
              };
            if (error instanceof CreationError && error.code === "conflict")
              return {
                success: false,
                text: stableJson({
                  error: "contextChanged",
                  retryable: true,
                  action:
                    "Read all panda_creation_context pages, apply current updates and goal, then retry the chosen output.",
                }),
              };
            if (
              error instanceof ImageRenderError ||
              (error instanceof CreationError &&
                ["invalidInput", "invalidOutput", "notFound", "unavailable"].includes(error.code))
            )
              return {
                success: false,
                text: stableJson({
                  error: error.code,
                  saved: false,
                  action:
                    "No artifact has been saved. Follow the renderer schema and reduce dense slide or scene text after invalidInput. Use an unused slot for corrected rendering input. For an uncertain result keep the original slot and unchanged arguments to reconcile it. Never substitute a planning document for the requested finished artifact.",
                }),
              };
            throw error;
          }
        },
      };
    },
  };
}
