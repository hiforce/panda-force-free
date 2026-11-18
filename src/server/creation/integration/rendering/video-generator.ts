import type { CreationArtifactGenerator } from "./generator-contracts.js";
import type { NativeCreationVideoRenderer } from "./native-video.js";
import { creationRecord } from "../../validation.js";
import { creationVideoComposition } from "./video-composition.js";
import { CreationError } from "../../contracts.js";

/** This renderer promises animated caption/image compositions, never filmed footage, screen recording or narration. */
export function creationVideoGenerator(renderer: NativeCreationVideoRenderer): CreationArtifactGenerator {
  return {
    kind: "video",
    mode: "motion-graphics-silent",
    available: () => renderer.available(),
    definition: {
      name: "panda_videos_render",
      description:
        "Render a real playable H.264 MP4 as silent animated text/image scenes, with subtle camera motion and fades. This backend does not create filmed footage, screen recordings, narration, music or synchronized speech. If the user's essential request needs those, ask what to do instead of silently omitting them. Choose landscape or portrait and provide complete concise scene content, 3–12 seconds per scene, at most 12 scenes and 90 seconds total. Titles support two short lines (three in portrait); captions must fit the available area, so split dense content when validation rejects it. Optional imageHandle comes from this task's panda_images_render. For a previous application-generated composition, first read it fully with panda_creation_original_read, then supply sourceId and any returned originalImage names to reuse its images. This rebuilds a new video from the editable composition, preserves the previous video, and cannot edit arbitrary uploaded footage. Use a stable slot for unchanged retries; save kind:video via panda_artifacts_save after rendering. Report the actual silent motion-graphics mode.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "scenes"],
        properties: {
          slot: { type: "integer", minimum: 1, maximum: 8 },
          sourceId: { type: "string", pattern: "^[a-f0-9]{64}$" },
          aspect: { type: "string", enum: ["landscape", "portrait"] },
          scenes: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["duration", "heading", "text"],
              properties: {
                duration: { type: "integer", minimum: 3, maximum: 12 },
                heading: { type: "string", minLength: 1, maxLength: 120 },
                text: { type: "string", maxLength: 360 },
                imageHandle: { type: "string", pattern: "^[a-f0-9]{64}$" },
                originalImage: { type: "string", maxLength: 240 },
              },
            },
          },
        },
      },
    },
    async render(value, context) {
      const { slot: _slot, sourceId, ...composition } = creationRecord(value, ["slot", "sourceId", "aspect", "scenes"]);
      const captured = creationVideoComposition(composition),
        names = [...new Set(captured.scenes.flatMap((s) => (s.originalImage ? [s.originalImage] : [])))],
        resources = new Map(
          (sourceId === undefined ? [] : await context.sources.videoResources(sourceId, names)).map((r) => [
            r.name,
            r.bytes,
          ]),
        );
      return renderer.render(composition, {
        signal: context.signal,
        image: context.image,
        authorize: context.authorize,
        ...(sourceId === undefined
          ? {}
          : {
              originalImage: async (name: string) => {
                const bytes = resources.get(name);
                if (!bytes) throw new CreationError("notFound");
                return bytes;
              },
            }),
      });
    },
  };
}
