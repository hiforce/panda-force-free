import type { PortableTemplateOrigin } from "./registry.js";
import { templateAssert } from "./errors.js";
import { templateDigest, templateObject, templateText, templateInteger } from "./validation.js";
import { sourceOrigin } from "../../packages/sources/origin.js";
import { sourcePath } from "../../packages/sources/paths.js";

export function portableTemplateOrigin(value: unknown): PortableTemplateOrigin {
  if (value && typeof value === "object" && "kind" in value && value.kind === "captured") {
    const input = templateObject(value, ["kind", "source", "root", "sha256"]);
    return {
      kind: "captured",
      source: sourceOrigin(input.source),
      root: input.root === "" ? "" : sourcePath(input.root),
      sha256: templateDigest(input.sha256),
    };
  }
  if (value && typeof value === "object" && "kind" in value && value.kind === "authoring") {
    const input = templateObject(value, ["kind", "draftId", "revision", "digest", "sha256"]),
      draftId = templateText(input.draftId, 36);
    templateAssert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(draftId));
    return {
      kind: "authoring",
      draftId,
      revision: templateInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
      digest: templateDigest(input.digest),
      sha256: templateDigest(input.sha256),
    };
  }
  const input = templateObject(value, ["kind", "name", "sha256"]),
    name = templateText(input.name, 160);
  templateAssert(input.kind === "upload" && !/[\p{Cc}\p{Cf}\\/]/u.test(name));
  return { kind: "upload", name, sha256: templateDigest(input.sha256) };
}
