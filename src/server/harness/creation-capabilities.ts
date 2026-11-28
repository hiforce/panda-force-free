import type { HarnessCreationCapabilities } from "../../shared/creation/media-executors.js";
import type { HarnessRuntimeView } from "../../shared/harness/contracts.js";
import directory from "./creation-capabilities.json";

export async function harnessCreationCapabilities(
  runtime: HarnessRuntimeView,
  probe?: () => Promise<boolean | string>,
  model?: string,
): Promise<HarnessCreationCapabilities> {
  const entry = directory.harnesses[runtime.kind];
  const verified =
    directory.schema === 1 &&
    directory.scope === "creation" &&
    runtime.enabled &&
    runtime.status === "ready" &&
    runtime.protocol === entry.protocol;
  const text = verified && entry.text && runtime.capabilities?.text === true;
  const applicationTools = verified && entry.applicationTools && runtime.capabilities?.tools === true;
  const image = entry.nativeImage;
  const catalogModel =
    image?.orchestratorModel === "runtime-catalog" &&
    runtime.models.some((available) => !model || available.id === model);
  const result = image && applicationTools && catalogModel ? await probe?.().catch(() => false) : false;
  const nativeImage = image !== null && result === (image.version ?? true);
  return {
    catalogVersion: directory.version,
    reviewedOn: directory.reviewedOn,
    text,
    applicationTools,
    imageUnderstanding: verified && entry.imageUnderstanding && runtime.capabilities?.imageInput === true,
    imageEditing: nativeImage && image.editing,
    nativeImage,
    nativeImageStatus: nativeImage ? "available" : image ? "unverified" : "unsupported",
    nativeVideo: verified && entry.nativeVideo,
  };
}
