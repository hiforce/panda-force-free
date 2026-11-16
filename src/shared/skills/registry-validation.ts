import type { SkillPackOrigin } from "./registry.js";
import { packageId, resourcePath } from "./manifest/identity.js";
import { oneOf, record, text } from "./manifest/primitives.js";
import { skillAssert } from "./errors.js";
export function skillDigest(value: unknown): string {
  const result = text(value, 64, "digest");
  skillAssert(/^[a-f0-9]{64}$/.test(result), "invalidIdentity", "digest");
  return result;
}
export function skillOperationId(value: unknown): string {
  const result = text(value, 36, "operationId");
  skillAssert(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(result),
    "invalidIdentity",
    "operationId",
  );
  return result.toLowerCase();
}
export function skillOrigin(value: unknown): SkillPackOrigin {
  const row = record(value, ["kind", "name", "sha256", "repository", "commit", "packagePath", "id"]),
    kind = oneOf(row.kind, ["upload", "github", "builtin"], "origin.kind");
  if (kind === "builtin") {
    record(row, ["kind", "id"]);
    return { kind, id: packageId(row.id) };
  }
  if (kind === "upload") {
    record(row, ["kind", "name", "sha256"]);
    const name = text(row.name, 255, "origin.name");
    skillAssert(!/[\\/]/.test(name), "invalidManifest", "origin.name");
    return { kind, name, sha256: skillDigest(row.sha256) };
  }
  record(row, ["kind", "repository", "commit", "packagePath", "sha256"]);
  const repository = text(row.repository, 1000, "origin.repository"),
    commit = text(row.commit, 64, "origin.commit");
  skillAssert(
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
    "invalidManifest",
    "origin",
  );
  return {
    kind,
    repository,
    commit,
    packagePath: row.packagePath === "" ? "" : resourcePath(row.packagePath),
    sha256: skillDigest(row.sha256),
  };
}
