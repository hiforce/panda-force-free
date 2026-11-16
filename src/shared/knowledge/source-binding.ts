import type { SavedSourceBinding, SavedSourceResource } from "../content-sources/contracts.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../creative/assets.js";
import { KnowledgeError } from "./contracts.js";
import { knowledgeDigest, knowledgeObject, knowledgeText } from "./primitives.js";

function resource(value: unknown, maximum: number): SavedSourceResource {
  const row = knowledgeObject(value, ["name", "digest", "size"]),
    name = knowledgeText(row.name, 512);
  if (
    /[\\?#:%\p{Cc}\p{Cf}\p{Cs}]/u.test(name) ||
    name.split("/").some((part) => !part || part.startsWith(".")) ||
    !Number.isSafeInteger(row.size) ||
    Number(row.size) < 1 ||
    Number(row.size) > maximum
  )
    throw new KnowledgeError("invalidInput");
  return { name, digest: knowledgeDigest(row.digest), size: Number(row.size) };
}

/** Native evidence binds immutable originals and resources; absent bindings retain historical document records. */
export function knowledgeSourceBinding(value: unknown, id: string): SavedSourceBinding {
  const row = knowledgeObject(value, ["kind", "path", "blob", "original", "resources"]);
  if (
    !["web", "slides"].includes(String(row.kind)) ||
    !/^c-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
    row.path !== `creations/${id}.panda.json` ||
    typeof row.blob !== "string" ||
    !/^[a-f0-9]{40}$/.test(row.blob) ||
    !Array.isArray(row.resources) ||
    row.resources.length > limits.resources
  )
    throw new KnowledgeError("invalidInput");
  const kind = row.kind as "web" | "slides",
    original = resource(row.original, kind === "web" ? limits.htmlBytes : limits.sourceBytes),
    resources = row.resources.map((value) => resource(value, limits.resourceBytes)),
    names = [original.name, ...resources.map((entry) => entry.name)].map((name) => name.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    original.size + resources.reduce((bytes, entry) => bytes + entry.size, 0) > limits.totalBytes ||
    !original.name.toLowerCase().endsWith(kind === "web" ? ".html" : ".pptx")
  )
    throw new KnowledgeError("invalidInput");
  return { kind, path: row.path, blob: row.blob, original, resources };
}
