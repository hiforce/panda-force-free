import sharp from "sharp";
import type { CreationInputSnapshot } from "../../input.js";
import type { CreationMaterial } from "../../../../shared/creation/contracts.js";
import type { ApplicationToolDefinition, ApplicationToolResult } from "../../../../shared/engine/application-tools.js";
import type { CreationAssetAccess } from "../media-output.js";
import type { CreationMaterialPort } from "../../materials.js";
import { CreationError, CreationWriteError } from "../../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { imageDigest } from "./image-result.js";
import { NativePresentation } from "../../../slides/office/package.js";
import { applyNativeContent } from "../../../slides/office/apply.js";
import type { NativeContentSlot, NativeSlotValue } from "../../../../shared/slides/mapping.js";
import type { ImmutableSlides } from "../../../slides/office/package.js";
import type { NativeSlideShape } from "../../../../shared/slides/contracts.js";
import type { GeneratedOriginal } from "./generated-originals.js";
import { DocumentError } from "../../../documents/errors.js";
import { VIDEO_COMPOSITION_RESOURCE } from "./native-video.js";
import { creationVideoComposition } from "./video-composition.js";

export class CreationOriginalError extends Error {
  constructor(readonly code: "originalNotRead" | "unsupportedSource") {
    super(code);
  }
}
interface Selection {
  id: string;
  kind: string;
  material?: CreationMaterial;
}
interface Original {
  id: string;
  kind: string;
  bytes: Uint8Array;
  resources: { name: string; bytes: Uint8Array }[];
}
const flatten = (shapes: readonly ImmutableSlides<NativeSlideShape>[]): readonly ImmutableSlides<NativeSlideShape>[] =>
  shapes.flatMap((shape) => [shape, ...flatten(shape.children)]);
export const ORIGINAL_READ_TOOL = "panda_creation_original_read";
export const originalReadDefinition: ApplicationToolDefinition = {
  name: ORIGINAL_READ_TOOL,
  description:
    "Read the authorized previous original or an uploaded source selected by materialId from the current context. Presentations return one page with editable slot references; read each returned nextOffset in order before editing those slots. Web pages return complete original HTML in pages and owned resource names. Application-generated motion graphics return their editable scene composition; arbitrary uploaded video footage has no editable composition. Images return a bounded preview. The sourceId belongs only to this task and cannot select another asset, filesystem path or URL. Use panda_slides_edit to preserve an existing deck, panda_web_render with retainedResources to reuse selected web resources, or panda_videos_render with sourceId and originalImage names to rebuild a read composition.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      materialId: { type: "string" },
      page: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
      resourceOffset: { type: "integer", minimum: 0 },
    },
  },
};
/** A source token binds immutable original identity and read coverage, while large byte buffers stay inside one bounded call. */
export class CreationOriginalSources {
  private readonly selections = new Map<string, Selection>();
  private readonly coverage = new Map<string, number>();
  private readonly slots = new Map<string, Map<string, NativeContentSlot>>();
  private readonly webRead = new Set<string>();
  private readonly videoRead = new Set<string>();
  constructor(
    private readonly input: Pick<CreationInputSnapshot, "owner" | "taskId" | "previousAsset">,
    private readonly assets: CreationAssetAccess,
    private readonly materials: () => Promise<readonly CreationMaterial[]>,
    private readonly materialPort?: CreationMaterialPort,
  ) {}
  private async choose(materialId?: unknown): Promise<Selection> {
    let selection: Selection;
    if (materialId !== undefined) {
      const id = creationUuid(materialId),
        material = (await this.materials()).find((m) => m.id === id);
      if (!material || !this.materialPort?.readOriginal) throw new CreationError("notFound");
      const kind =
        material.kind === "image"
          ? "image"
          : /\.pptx$/i.test(material.name)
            ? "slides"
            : /\.html?$/i.test(material.name)
              ? "web"
              : "file";
      selection = {
        id: imageDigest(stableJson({ owner: this.input.owner, taskId: this.input.taskId, material })),
        kind,
        material,
      };
    } else {
      const previous = this.input.previousAsset?.artifact;
      if (!previous) throw new CreationError("notFound");
      selection = {
        id: imageDigest(stableJson({ owner: this.input.owner, taskId: this.input.taskId, previous })),
        kind: previous.kind,
      };
    }
    if (!this.selections.has(selection.id) && this.selections.size >= 10) throw new CreationError("invalidInput");
    this.selections.set(selection.id, selection);
    return selection;
  }
  private async load(sourceId: string): Promise<Original> {
    const selected = this.selections.get(creationDigest(sourceId));
    if (!selected) throw new CreationOriginalError("originalNotRead");
    if (selected.material)
      return {
        id: selected.id,
        kind: selected.kind,
        resources: [],
        bytes: await this.materialPort!.readOriginal!(this.input.owner, selected.material),
      };
    const previous = this.input.previousAsset!.artifact;
    try {
      const actual = await (
        await this.assets(this.input.owner, previous.projectId)
      ).original(previous.projectId, previous.assetId);
      if (actual.asset.version !== previous.version || actual.asset.source.digest !== previous.source.digest)
        throw new CreationError("conflict");
      return { id: selected.id, kind: selected.kind, bytes: actual.bytes, resources: actual.resources };
    } catch (error) {
      throw new CreationWriteError(
        (error instanceof CreationError && error.code === "conflict") ||
          (error instanceof DocumentError && ["notFound", "conflict"].includes(error.code))
          ? "targetChanged"
          : "writeUnavailable",
        error,
      );
    }
  }
  async read(value: unknown): Promise<ApplicationToolResult> {
    const args = creationRecord(value, ["materialId", "page", "offset", "resourceOffset"]),
      selected = await this.choose(args.materialId),
      original = await this.load(selected.id),
      offset = args.offset === undefined ? 0 : creationInteger(args.offset),
      page = args.page === undefined ? 1 : creationInteger(args.page);
    let text: string,
      pageSlots: NativeContentSlot[] = [],
      extra: Record<string, unknown>;
    if (original.kind === "image") {
      const preview = await sharp(original.bytes, { limitInputPixels: 40_000_000 })
        .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer();
      return {
        success: true,
        text: stableJson({ sourceId: original.id, kind: "image" }),
        images: ["data:image/webp;base64," + preview.toString("base64")],
      };
    }
    if (original.kind === "slides") {
      const deck = await NativePresentation.open(original.bytes, "Source.pptx"),
        part = deck.index.slides[page - 1];
      if (!part || !page) throw new CreationError("invalidInput");
      const shapes = flatten(deck.part(part.path).shapes).flatMap((shape) => {
        const kind =
          shape.kind === "text" && shape.placeholder?.type !== "pic"
            ? "text"
            : (shape.kind === "picture" && shape.image) || shape.placeholder?.type === "pic"
              ? "image"
              : null;
        if (!kind) return [];
        const id =
          "s-" + imageDigest(stableJson({ source: original.id, part: part.path, shape: shape.id })).slice(0, 40);
        pageSlots.push({
          id,
          label: kind === "text" ? "Text" : "Image",
          kind,
          required: false,
          target: { part: part.path, shapeId: shape.id },
        });
        return [{ slot: id, kind, ...(kind === "text" ? { text: shape.text } : {}) }];
      });
      text = stableJson({ page, slides: deck.index.slides.length, shapes });
      extra = { page, slides: deck.index.slides.length };
    } else if (original.kind === "web") {
      text = new TextDecoder("utf-8", { fatal: true }).decode(original.bytes);
      const resourceOffset = args.resourceOffset === undefined ? 0 : creationInteger(args.resourceOffset),
        resources = original.resources.slice(resourceOffset, resourceOffset + 10);
      extra = {
        resources: resources.map((r) => r.name),
        resourceCount: original.resources.length,
        nextResourceOffset:
          resourceOffset + resources.length < original.resources.length ? resourceOffset + resources.length : null,
      };
    } else if (original.kind === "video") {
      const source = original.resources.find((r) => r.name === VIDEO_COMPOSITION_RESOURCE);
      if (!source || source.bytes.length > 65536) throw new CreationOriginalError("unsupportedSource");
      const saved = creationRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)), [
        "schema",
        "mode",
        "aspect",
        "scenes",
      ]);
      if (saved.schema !== 1 || saved.mode !== "motion-graphics-silent")
        throw new CreationOriginalError("unsupportedSource");
      const composition = creationVideoComposition({ aspect: saved.aspect, scenes: saved.scenes });
      text = stableJson({ mode: saved.mode, ...composition });
      extra = { mode: saved.mode };
    } else throw new CreationOriginalError("unsupportedSource");
    const key = original.id + ":" + (original.kind === "slides" ? page : "html"),
      read = this.coverage.get(key) ?? 0;
    if (offset > read || offset > text.length) throw new CreationError("invalidInput");
    let end = Math.min(offset + 12000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    const covered = Math.max(read, end);
    this.coverage.set(key, covered);
    if (covered === text.length) {
      if (original.kind === "web") this.webRead.add(original.id);
      else if (original.kind === "video") this.videoRead.add(original.id);
      else {
        const allowed = this.slots.get(original.id) ?? new Map();
        for (const slot of pageSlots) allowed.set(slot.id, slot);
        this.slots.set(original.id, allowed);
      }
    }
    return {
      success: true,
      text: stableJson({
        sourceId: original.id,
        kind: original.kind,
        ...extra,
        text: text.slice(offset, end),
        offset,
        nextOffset: end < text.length ? end : null,
      }),
    };
  }
  async editSlides(value: unknown, image: (handle: string) => Promise<Uint8Array>): Promise<GeneratedOriginal> {
    const args = creationRecord(value, ["slot", "sourceId", "changes"]),
      sourceId = creationDigest(args.sourceId),
      original = await this.load(sourceId),
      allowed = this.slots.get(sourceId);
    if (
      original.kind !== "slides" ||
      !allowed ||
      !Array.isArray(args.changes) ||
      !args.changes.length ||
      args.changes.length > 128
    )
      throw new CreationOriginalError("originalNotRead");
    const changes = args.changes.map((entry) => {
      const row = creationRecord(entry, ["slot", "text", "imageHandle"]),
        slot = allowed.get(creationText(row.slot, 64));
      if (
        !slot ||
        (slot.kind === "text" &&
          (typeof row.text !== "string" || row.text.length > 10000 || row.imageHandle !== undefined)) ||
        (slot.kind === "image" && (row.text !== undefined || row.imageHandle === undefined))
      )
        throw new CreationError("invalidInput");
      return {
        slot,
        text: row.text,
        imageHandle: row.imageHandle === undefined ? undefined : creationDigest(row.imageHandle),
      };
    });
    if (new Set(changes.map((c) => c.slot.id)).size !== changes.length) throw new CreationError("invalidInput");
    const deck = await NativePresentation.open(original.bytes, "Source.pptx"),
      values: Record<string, NativeSlotValue> = {};
    for (const change of changes)
      values[change.slot.id] =
        change.slot.kind === "text"
          ? { kind: "text", text: String(change.text) }
          : {
              kind: "image",
              mediaType: "image/png",
              bytes: await sharp(await image(change.imageHandle!), { limitInputPixels: 40_000_000 })
                .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
                .png()
                .toBuffer(),
            };
    const result = await applyNativeContent(
      deck,
      {
        schema: "panda.powerpoint-mapping/v1",
        sourceSha256: deck.index.source.sha256,
        slots: changes.map((c) => c.slot),
      },
      values,
    );
    await NativePresentation.open(result.bytes, "Edited.pptx");
    return { kind: "slides", name: "presentation.pptx", bytes: result.bytes };
  }
  async webResources(sourceId: unknown, names: unknown) {
    const id = creationDigest(sourceId);
    if (!this.webRead.has(id)) throw new CreationOriginalError("originalNotRead");
    const original = await this.load(id);
    if (original.kind !== "web" || !Array.isArray(names) || names.length > 128 || new Set(names).size !== names.length)
      throw new CreationError("invalidInput");
    return names.map((name) => {
      const resource = original.resources.find((r) => r.name === name);
      if (!resource) throw new CreationError("notFound");
      return resource;
    });
  }
  async videoResources(sourceId: unknown, names: unknown) {
    const id = creationDigest(sourceId);
    if (!this.videoRead.has(id)) throw new CreationOriginalError("originalNotRead");
    const original = await this.load(id);
    if (original.kind !== "video" || !Array.isArray(names) || names.length > 12 || new Set(names).size !== names.length)
      throw new CreationError("invalidInput");
    return names.map((name) => {
      if (typeof name !== "string" || !/^images\/scene-\d+\.png$/.test(name)) throw new CreationError("invalidInput");
      const resource = original.resources.find((r) => r.name === name);
      if (!resource) throw new CreationError("notFound");
      return resource;
    });
  }
}
