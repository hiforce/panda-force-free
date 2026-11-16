import { parseDocument } from "yaml";
import { DocumentError } from "../errors.js";
import { publicMetadataKeys, publicDocumentMetadata } from "../../../shared/sites/metadata.js";

/** Reject custom types, duplicate keys and aliases; configuration parsing never runs project code. */
export function sourceYaml(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source) > 64 * 1024) throw new DocumentError("tooLarge", 413);
  try {
    const doc = parseDocument(source, {
      schema: "core",
      uniqueKeys: true,
      resolveKnownTags: false,
      logLevel: "silent",
    });
    if (doc.errors.length || doc.warnings.length) throw Error("Invalid YAML");
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid mapping");
    return value as Record<string, unknown>;
  } catch {
    throw new DocumentError("invalidSourceConfiguration");
  }
}
export function sourceMetadata(content: string, fields: string[] = []) {
  const raw = content.replace(/\r\n?/g, "\n").match(/^\ufeff?---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!raw) return {};
  const input = sourceYaml(raw);
  return publicDocumentMetadata(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => publicMetadataKeys.includes(key) || fields.includes(key)),
    ),
    fields,
  );
}
