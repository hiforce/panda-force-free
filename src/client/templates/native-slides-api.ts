import { templateJson } from "./api.js";
import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";
import type {
  NativeSlidesInput,
  NativeSlidesSourceReference,
  NativeSlidesProposal,
  NativeSlidesReview,
  NativeSlidesInstallResult,
  NativeSlidesSnapshot,
} from "../../shared/slides/registry.js";
import type { NativeSlidePart, NativePresentationIndex } from "../../shared/slides/contracts.js";
import type { NativeContentMapping } from "../../shared/slides/mapping.js";

export type NativeSlidesReference = { id: string; version: string; digest: string };
export const nativeSlidesApi = {
  prepare: (source: NativeSlidesSourceReference) =>
    templateJson<NativeSlidesProposal>("/api/templates/native-slides/prepare", "POST", { source }),
  part: (source: NativeSlidesSourceReference, part: string) =>
    templateJson<NativeSlidePart>("/api/templates/native-slides/part", "POST", { source, part }),
  review: (input: NativeSlidesInput) =>
    templateJson<NativeSlidesReview>("/api/templates/native-slides/review", "POST", input),
  install: (input: NativeSlidesInput, value: NativeSlidesReview, operationId: string) =>
    templateJson<NativeSlidesInstallResult>("/api/templates/native-slides/install", "POST", {
      ...input,
      approval: {
        operationId,
        expectedRevision: value.revision,
        reviewHash: value.reviewHash,
        licenseAcknowledged: true,
      },
    }),
  list: () => templateJson<NativeSlidesSnapshot>("/api/templates/native-slides"),
  content: (ref: NativeSlidesReference) =>
    templateJson<{
      original: NativePresentationIndex;
      mapping: NativeContentMapping;
      licenseText: string;
      readmeText: string;
    }>("/api/templates/native-slides/content?" + new URLSearchParams(ref)),
  originalUrl: (ref: NativeSlidesReference) => "/api/templates/native-slides/original?" + new URLSearchParams(ref),
  async export(ref: NativeSlidesReference) {
    const response = await request("/api/templates/native-slides/export?" + new URLSearchParams(ref));
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.blob();
  },
  state: (reference: NativeSlidesReference, action: "enable" | "disable" | "activate", expectedRevision: number) =>
    templateJson("/api/templates/native-slides/state", "PUT", { reference, action, expectedRevision }),
};
