import { posix } from "node:path";
import type { DocumentEngine } from "../../../shared/documents/contracts.js";

/** Interpret engine URL conventions without reading configuration or executing helpers. */
export function imageCandidates(document: string, source: string, engine: DocumentEngine): string[] {
  if (source.length > 2048) return [];
  let value = source.startsWith("pathname://") ? source.slice("pathname://".length) : source;
  if (!value || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return [];
  try {
    value = decodeURIComponent(value.split(/[?#]/)[0]!);
  } catch {
    return [];
  }
  if (
    /[\\\p{Cc}]/u.test(value) ||
    !/\.(png|jpe?g|webp)$/i.test(value) ||
    value.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..")
  )
    return [];
  const rooted = value.startsWith("/"),
    path = value.replace(/^\/+/, ""),
    directory = posix.dirname(document);
  let candidates: string[];
  if (rooted) {
    const edition = document.split("/")[0]!;
    candidates =
      engine === "docusaurus"
        ? [posix.join("static", path)]
        : engine === "hexo"
          ? [...(/^source(?:-[a-z-]+)?$/i.test(edition) ? [posix.join(edition, path)] : []), path]
          : [path];
  } else
    candidates = [
      posix.join(directory, path),
      ...(engine === "hexo" ? [posix.join(document.replace(/\.(md|markdown)$/i, ""), path)] : []),
    ];
  return [...new Set(candidates.map((path) => posix.normalize(path)))].filter(
    (path) => path !== ".." && !path.startsWith("../") && !path.startsWith("/"),
  );
}
