import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type {
  TemplateSourceCandidate,
  TemplateSourceInspection,
  TemplateSourceKind,
} from "../../../shared/templates/sources/contracts.js";

type JsonRecord = Record<string, unknown>;
export const sourceRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const sourceRootEligible = (root: string) =>
  !root.split("/").some((part) => part === "node_modules" || part === ".git");
export const sourcePathAt = (root: string, path: string) => (root ? root + "/" + path : path);
const label = (value: unknown) =>
  typeof value === "string" && value.trim() && value.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : null;

/** A recognition index exposes bounded metadata reads and never loads executable configuration. */
export class TemplateSourceIndex {
  readonly files: CapturedPackageSource["tree"]["files"];
  readonly issues: TemplateSourceInspection["issues"][number][] = [];
  private byPath;
  private metadataCache = new Map<string, JsonRecord | null>();
  constructor(readonly source: CapturedPackageSource) {
    this.files = source.tree.files;
    this.byPath = new Map(this.files.map((file) => [file.path, file]));
  }
  has(root: string, path: string) {
    return this.byPath.has(sourcePathAt(root, path));
  }
  under(root: string, path: string) {
    return this.files.filter((file) => file.path.startsWith(sourcePathAt(root, path) + "/"));
  }
  entries(name: string) {
    return this.files
      .filter((file) => sourceRootEligible(file.path) && file.path.split("/").at(-1) === name)
      .map((file) => ({ path: file.path, root: file.path.split("/").slice(0, -1).join("/") }));
  }
  metadata(path: string, maxBytes = 256 * 1024): JsonRecord | null {
    const key = JSON.stringify([path, maxBytes]);
    if (this.metadataCache.has(key)) return this.metadataCache.get(key)!;
    const file = this.byPath.get(path);
    let result: JsonRecord | null = null;
    if (!file || file.bytes > maxBytes) this.issues.push({ path, code: "metadataTooLarge" });
    else {
      try {
        const value: unknown = JSON.parse(this.source.tree.text(path, maxBytes));
        if (sourceRecord(value)) result = value;
      } catch {
        /* A closed diagnostic below replaces any parser text containing original source bytes. */
      }
      if (!result) this.issues.push({ path, code: "metadataInvalid" });
    }
    this.metadataCache.set(key, result);
    return result;
  }
  candidate(
    kind: TemplateSourceKind,
    root: string,
    evidence: readonly string[],
    name?: unknown,
  ): TemplateSourceCandidate {
    return {
      kind,
      root,
      evidence,
      name:
        label(name) ||
        root.split("/").at(-1) ||
        (this.source.descriptor.origin.kind === "zip-upload"
          ? this.source.descriptor.origin.name
          : this.source.descriptor.origin.repository),
    };
  }
}

/** Package entry metadata is a hint into the captured inventory, never a path to load or execute. */
export function sourceModuleEntry(index: TemplateSourceIndex, root: string, main: unknown) {
  return [main, "index.js", "index.cjs", "index.mjs", "lib/index.js"]
    .filter((path): path is string => typeof path === "string" && path.length <= 1024)
    .map((path) => path.replace(/^(?:\.\/)+/, ""))
    .find((path) => path && index.has(root, path));
}
