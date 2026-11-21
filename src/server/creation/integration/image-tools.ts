import sharp from "sharp";
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
import { ImageRenderError, type ImageRenderRequest } from "./rendering/image-contracts.js";
import { imageDigest } from "./rendering/image-result.js";
import { CreationCandidateChanged, type CreationGeneratedOriginals } from "./rendering/generated-originals.js";
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
const definitions: ApplicationToolDefinition[] = [
  {
    name: RENDER_IMAGE_TOOL,
    description:
      "Generate or edit one finished raster image using the configured native image backend. Read all current context first. Use a detailed prompt covering the user's actual subject, labels, composition and style. slot is a stable choice from 1 to 8: retry the same slot and unchanged prompt to recover the same result without new inference; use a new slot only for a deliberate new candidate. Optional materialIds are images explicitly provided to this task, listed by panda_creation_context. No arbitrary files, paths or URLs. The returned handle belongs only to this task. Inspect the returned image, then save the chosen result with panda_artifacts_save; rendering alone does not complete this task.",
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
  materials?: CreationMaterialPort;
  messages?: Pick<CreationMessages, "context">;
  assets: CreationAssetAccess;
  generated?: CreationGeneratedOriginals;
  generators?: readonly CreationArtifactGenerator[];
}): CreationRendering {
  const generators = options.generators ?? [],
    kinds = [...new Set(["image", ...generators.map((g) => g.kind)])];
  const primaryDefinitions = structuredClone(definitions);
  primaryDefinitions[1]!.description =
    "Save this task's finished rendered artifact using its owned handle, true kind and concise title. This persists the original and returns a real receipt. Repeat calls return the same primary. Project, identity, filename and permissions belong to the application. Rendering alone is not a saved artifact; never substitute a brief, outline or script.";
  (primaryDefinitions[1]!.inputSchema.properties as Record<string, unknown>).kind = { type: "string", enum: kinds };
  return {
    async available() {
      const [image, available] = await Promise.all([
        options.available().catch(() => false),
        Promise.all(
          generators.map(async (g) => (!g.available || (await g.available().catch(() => false)) ? [g.kind] : [])),
        ),
      ]);
      return [...new Set([...(image ? ["image" as const] : []), ...available.flat()])];
    },
    open(context) {
      const task = context.task;
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
                ...structuredClone(primaryDefinitions),
                structuredClone(originalReadDefinition),
                ...generators
                  .filter((g) => task.kind === "auto" || task.kind === g.kind)
                  .map((g) => structuredClone(g.definition)),
              ],
        async call(value) {
          const call = structuredClone(value);
          const bound = context.execution(call);
          context.signal.throwIfAborted();
          try {
            if (call.name === SAVE_ARTIFACT_TOOL) {
              const current = await options.tasks.get(task.owner, task.id);
              if (current.generation !== bound.generation) throw new CreationError("leaseLost");
              if (current.artifact) return { success: true, text: stableJson(current.artifact) };
              const execution = await context.assert(call),
                args = creationRecord(call.arguments, ["kind", "handle", "title"]);
              if (!kinds.includes(String(args.kind))) throw new CreationError("invalidOutput");
              const saved = await options.outputs.invoke(
                execution,
                renderedCreationOutput({
                  owner: task.owner,
                  taskId: task.id,
                  kind: args.kind,
                  handle: creationDigest(args.handle),
                  title: creationText(args.title, 200),
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
                if (!options.generated || (generator.available && !(await generator.available())))
                  throw new CreationError("unavailable");
                const args = creationRecord(
                    call.arguments,
                    Object.keys(generator.definition.inputSchema.properties as object),
                  ),
                  key = await options.generated.render(
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
                    () =>
                      generator.render(args, {
                        signal: context.signal,
                        authorize: () => context.active(call),
                        sources,
                        image: async (handle) =>
                          (await options.journal.resolve(task.owner, task.id, handle)).receipt.bytes,
                      }),
                    () => context.active(call),
                  );
                await context.active(call);
                return {
                  success: true,
                  text: stableJson({
                    handle: key,
                    kind: generator.kind,
                    ...(generator.mode ? { renderingMode: generator.mode } : {}),
                    saved: false,
                  }),
                };
              }
              if (call.name !== RENDER_IMAGE_TOOL) throw new CreationError("invalidInput");
              const execution = await context.assert(call);
              if (!(await options.available())) throw new CreationError("unavailable");
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
                rawIds.length + (args.previousImage ? 1 : 0) > 2
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
                  profile: context.input.profile.media
                    ? { id: "codex", engineId: "codex", ...context.input.profile.media }
                    : context.input.profile,
                  images,
                },
                intent = await imageRenderIntent(request);
              await context.assert(call);
              const result = await options.renderer.render(request, {
                signal: context.signal,
                authorize: () => context.active(call),
              });
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
                  saved: false,
                }),
                images: ["data:image/webp;base64," + preview.toString("base64")],
              };
            });
          } catch (error) {
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
