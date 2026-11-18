import { renderCreationSlides } from "./native-slides.js";
import { renderCreationWeb } from "./native-web.js";
import { creationRecord } from "../../validation.js";
import { CreationError } from "../../contracts.js";
import type { NativeCreationVideoRenderer } from "./native-video.js";
import { creationVideoGenerator } from "./video-generator.js";

import type { CreationArtifactGenerator } from "./generator-contracts.js";
export type { CreationArtifactGenerator } from "./generator-contracts.js";
export function nativeCreationGenerators(video?: NativeCreationVideoRenderer): CreationArtifactGenerator[] {
  const slot = { type: "integer", minimum: 1, maximum: 8 };
  return [
    {
      kind: "slides",
      definition: {
        name: "panda_slides_render",
        description:
          "Create a real editable PowerPoint presentation. Provide complete slide content, never an outline disguised as a finished deck. Use cover, content or picture layouts; picture pages require an imageHandle from this task's panda_images_render. Titles allow at most two lines; use at most eight short body paragraphs and split dense content into more slides when validation rejects overflow. Use a stable slot for identical retries. After rendering save kind:slides with panda_artifacts_save; this tool alone does not save the primary artifact.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "pages"],
          properties: {
            slot,
            pages: {
              type: "array",
              minItems: 1,
              maxItems: 30,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["layout", "title"],
                properties: {
                  layout: { type: "string", enum: ["cover", "content", "picture"] },
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  body: { type: "string", maxLength: 2000 },
                  imageHandle: { type: "string" },
                },
              },
            },
          },
        },
      },
      async render(value, context) {
        const row = creationRecord(value, ["slot", "pages"]);
        context.signal.throwIfAborted();
        const result = await renderCreationSlides(row.pages, context.image);
        context.signal.throwIfAborted();
        return { kind: "slides", name: "presentation.pptx", bytes: result.bytes };
      },
    },
    {
      kind: "slides",
      definition: {
        name: "panda_slides_edit",
        description:
          "Edit a previous or uploaded real PowerPoint original while preserving the remaining slides, layouts, graphics and package. First read the relevant pages completely with panda_creation_original_read. Use only returned sourceId and editable slot references. Provide changed text or a task-owned imageHandle for picture slots. This produces a new deck; the saved original remains unchanged. Save the result as kind:slides with panda_artifacts_save. Use panda_slides_render for a deliberately redesigned deck instead.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "sourceId", "changes"],
          properties: {
            slot,
            sourceId: { type: "string", pattern: "^[a-f0-9]{64}$" },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["slot"],
                properties: {
                  slot: { type: "string" },
                  text: { type: "string", maxLength: 10000 },
                  imageHandle: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
              },
            },
          },
        },
      },
      async render(value, context) {
        context.signal.throwIfAborted();
        const result = await context.sources.editSlides(value, context.image);
        context.signal.throwIfAborted();
        return result;
      },
    },
    {
      kind: "web",
      definition: {
        name: "panda_web_render",
        description:
          "Create an actual self-contained responsive HTML page with real content and CSS, rather than a website brief or source-code document. Inline CSS and JavaScript can be retained in the downloadable original; the application online preview is isolated and does not run scripts. Never claim external deployment or online interactive execution. Include owned images as relative resources with {name,handle} using handles from this task's panda_images_render. To revise a previous or uploaded HTML page, read its complete HTML with panda_creation_original_read, then provide sourceId and explicit retainedResources names for original resources still used by the new HTML. Avoid external asset dependencies. Use a stable slot for identical retries, then save kind:web with panda_artifacts_save.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "html"],
          properties: {
            slot,
            sourceId: { type: "string", pattern: "^[a-f0-9]{64}$" },
            retainedResources: { type: "array", maxItems: 128, uniqueItems: true, items: { type: "string" } },
            html: { type: "string", minLength: 1, maxLength: 2097152 },
            images: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "handle"],
                properties: { name: { type: "string" }, handle: { type: "string" } },
              },
            },
          },
        },
      },
      async render(value, context) {
        const {
          slot: _slot,
          sourceId,
          retainedResources,
          ...source
        } = creationRecord(value, ["slot", "html", "images", "sourceId", "retainedResources"]);
        context.signal.throwIfAborted();
        if (sourceId === undefined && retainedResources !== undefined) throw new CreationError("invalidInput");
        const retained =
          sourceId === undefined ? [] : await context.sources.webResources(sourceId, retainedResources ?? []);
        const result = await renderCreationWeb(source, context.image);
        const resources = [...retained, ...(result.resources ?? [])];
        if (new Set(resources.map((r) => r.name.toLowerCase())).size !== resources.length)
          throw new CreationError("invalidInput");
        context.signal.throwIfAborted();
        return { ...result, resources };
      },
    },
    ...(video ? [creationVideoGenerator(video)] : []),
  ];
}
