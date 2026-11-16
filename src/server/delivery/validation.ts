import { digest } from "./digest.js";
export { digest } from "./digest.js";
import type { SitePublicationRequest } from "../../shared/delivery/contracts.js";
import { buildArtifact, buildId } from "../../shared/builds/validation.js";
import { DeliveryError } from "./errors.js";

export function publicationRequest(value: unknown): SitePublicationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeliveryError("invalidInput");
  const input = value as Record<string, unknown>;
  try {
    if (
      Object.keys(input).some(
        (key) => !["id", "buildId", "connectionId", "connectionVersion", "projectId"].includes(key),
      ) ||
      (input.projectId !== undefined &&
        (typeof input.projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.projectId))) ||
      typeof input.connectionVersion !== "number" ||
      !Number.isSafeInteger(input.connectionVersion) ||
      input.connectionVersion < 1
    )
      throw new Error("Invalid fields");
    return {
      id: buildId(String(input.id)),
      buildId: buildId(String(input.buildId)),
      connectionId: buildId(String(input.connectionId)),
      connectionVersion: input.connectionVersion,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId as string }),
    };
  } catch {
    throw new DeliveryError("invalidInput");
  }
}
export function verifiedArtifact(value: unknown) {
  try {
    const artifact = buildArtifact(value);
    for (const file of artifact.files)
      if (digest(Buffer.from(file.data, "base64")) !== file.sha256) throw new Error("Digest mismatch");
    // A file cannot also be a directory, including on case-insensitive filesystems.
    const paths = new Set(artifact.files.map((file) => file.path.toLowerCase()));
    for (const path of paths) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join("/"))) throw new Error("Path conflict");
      }
    }
    return artifact;
  } catch {
    throw new DeliveryError("artifactInvalid", 409);
  }
}
