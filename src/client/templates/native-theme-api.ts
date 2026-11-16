import { templateJson } from "./api.js";
import type {
  NativeThemeInput,
  NativeThemeSourceSelection,
  NativeThemeReview,
  NativeThemeProposal,
  NativeThemeInstallResult,
  NativeThemeList,
} from "../../shared/templates/native/contracts.js";
import type { BuildEngine } from "../../shared/builds/engines.js";
import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";

export const nativeThemeApi = {
  prepare: (source: NativeThemeSourceSelection, engine: BuildEngine) =>
    templateJson<NativeThemeProposal>("/api/templates/native/prepare", "POST", { source, engine }),
  review: (input: NativeThemeInput) => templateJson<NativeThemeReview>("/api/templates/native/review", "POST", input),
  install: (input: NativeThemeInput, review: NativeThemeReview, operationId: string) =>
    templateJson<NativeThemeInstallResult>("/api/templates/native/install", "POST", {
      ...input,
      approval: {
        operationId,
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        permissions: ["build:theme-code"],
        licenseAcknowledged: true,
      },
    }),
  list: () => templateJson<NativeThemeList>("/api/templates/native"),
  content: (reference: { id: string; version: string; digest: string }) =>
    templateJson<{ licenseText: string; readmeText: string }>(
      "/api/templates/native/content?" + new URLSearchParams(reference),
    ),
  async export(reference: { id: string; version: string; digest: string }) {
    const response = await request("/api/templates/native/export?" + new URLSearchParams(reference));
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.blob();
  },
  state: (
    reference: { id: string; version: string; digest: string },
    action: "enable" | "disable" | "activate",
    expectedRevision: number,
  ) => templateJson("/api/templates/native/state", "PUT", { reference, action, expectedRevision }),
};
