import { readSourceText as readSourceFile } from "./ingestion/files.js";
import { realpath, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { SourceDocument, SourceInspection } from "../../shared/documents/contracts.js";
import { isRecord } from "../../shared/records.js";
import { inside } from "../path-utils.js";
import { DocumentError } from "./errors.js";
import { contentHash } from "./content-hash.js";
import { MAX_DOCUMENT_BYTES, documentPath } from "./validation.js";

const ignored = new Set(["node_modules", "public", "build", "dist", "coverage", "vendor"]);
export class DocumentSourceReader {
  constructor(private allowedRoots: string[]) {}
  async root(input: string): Promise<string> {
    if (!isAbsolute(input) || input.split(/[\\/]/).some((part) => part.startsWith(".")))
      throw new DocumentError("outsideRoots", 403);
    let root: string;
    try {
      root = await realpath(input);
    } catch {
      throw new DocumentError("sourceUnavailable", 404);
    }
    let allowed = false;
    for (const candidate of this.allowedRoots) {
      try {
        if (inside(root, await realpath(candidate))) allowed = true;
      } catch {
        /* Unmounted roots grant no access. */
      }
    }
    if (!allowed) throw new DocumentError("outsideRoots", 403);
    if (!(await stat(root)).isDirectory()) throw new DocumentError("sourceUnavailable", 404);
    return root;
  }
  async inspect(input: string): Promise<SourceInspection> {
    const root = await this.root(input);
    let dependencies: Record<string, unknown> = {};
    const warnings: string[] = [];
    try {
      const pkg: unknown = JSON.parse(await readSourceFile(root, "package.json", 256_000));
      if (isRecord(pkg))
        dependencies = {
          ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
          ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
        };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warnings.push("packageUnavailable");
    }
    const engine = dependencies.hexo ? "hexo" : dependencies["@docusaurus/core"] ? "docusaurus" : "markdown";
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    const sourceDirectories =
      engine === "hexo"
        ? directories.filter((name) => /^source(?:-[a-z-]+)?$/i.test(name))
        : engine === "docusaurus"
          ? directories.filter((name) => ["docs", "blog", "i18n"].includes(name))
          : ["."];
    if (!sourceDirectories.length) warnings.push("noSourceDirectories");
    const version = engine === "hexo" ? dependencies.hexo : dependencies["@docusaurus/core"];
    return { root, engine, detectedVersion: typeof version === "string" ? version : null, sourceDirectories, warnings };
  }
  async scan(input: string, locale: string) {
    const inspection = await this.inspect(input),
      documents: SourceDocument[] = [],
      skipped: string[] = [];
    let bytes = 0,
      visited = 0,
      truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 12) {
        skipped.push(relative(inspection.root, directory));
        return;
      }
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++visited > 10000 || documents.length >= 1000 || bytes >= 20 * 1024 * 1024) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
        const path = join(directory, entry.name),
          relativePath = relative(inspection.root, path).replaceAll("\\", "/");
        if (entry.isSymbolicLink()) {
          skipped.push(relativePath);
          continue;
        }
        if (entry.isDirectory()) {
          if (!inside(await realpath(path), inspection.root)) throw new DocumentError("outsideRoots", 403);
          await walk(path, depth + 1);
          if (truncated) return;
        } else if (entry.isFile() && /\.(md|mdx|markdown)$/i.test(entry.name)) {
          try {
            documentPath(relativePath);
            const content = await readSourceFile(inspection.root, relativePath, MAX_DOCUMENT_BYTES);
            bytes += Buffer.byteLength(content);
            if (bytes > 20 * 1024 * 1024) {
              truncated = true;
              return;
            }
            const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
            const rawTitle =
              front.match(/^title:\s*(.+)$/m)?.[1] ||
              content.match(/^#\s+(.+)$/m)?.[1] ||
              basename(entry.name).replace(/\.(md|mdx|markdown)$/i, "");
            const title = rawTitle
              .replace(/^["']|["']$/g, "")
              .trim()
              .slice(0, 200);
            const language = /source-zh|\/zh(?:-CN)?\//.test(relativePath)
              ? "zh-CN"
              : /source-en|\/en\//.test(relativePath)
                ? "en"
                : locale;
            documents.push({ path: relativePath, title, locale: language, content, hash: contentHash(content) });
          } catch {
            skipped.push(relativePath);
          }
        }
      }
    };
    for (const directory of inspection.sourceDirectories) {
      await walk(resolve(inspection.root, directory), 0);
      if (truncated) break;
    }
    return { inspection, documents, skipped, truncated };
  }
}
