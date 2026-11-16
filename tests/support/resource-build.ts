import { createHash } from "node:crypto";
import { buildInput } from "../../src/shared/builds/validation.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";
import { BUILD_ENGINES, type BuildEngine, type BuildArtifact } from "../../src/shared/builds/contracts.js";

export const resourceBuildBase = (engine: BuildEngine = "hexo") =>
  buildInput({
    protocol: 1,
    engine,
    preset: engine === "hexo" ? "reader" : "handbook",
    site: { title: "Native theme fixture", url: "https://example.test", basePath: "/", locale: "en" },
    documents: [{ id: "a", path: "intro.md", title: "Welcome", content: "Native content" }],
    assets: [],
  });
export async function resourceBuildFixture(
  files: Record<string, Uint8Array | string> = {
    "layout/index.ejs": "<h1>Native</h1>",
    "source/logo.bin": new Uint8Array([0, 10, 255]),
  },
  engine: BuildEngine = "hexo",
) {
  const tree = await ImmutableSourceTree.create(
      Object.entries(files).map(([path, bytes]) => ({
        path,
        bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      })),
    ),
    digest = "c".repeat(64),
    root = "themes/company",
    projectionDigest = await contentSha256(
      JSON.stringify({
        schema: "panda.source-alias-projection/v1",
        sourceDigest: digest,
        root,
        treeDigest: tree.digest,
      }),
    ),
    theme = {
      schema: 1,
      id: "company.native",
      version: "1.0.0",
      engine,
      engineVersion: BUILD_ENGINES[engine],
      source: { digest, projectionDigest, root },
      entry: engine === "hexo" ? null : "index.js",
      dependencies: {},
    };
  return {
    tree,
    theme,
    input: resourceBuildBase(engine),
    request: await ResourceBuildRequest.create(resourceBuildBase(engine), theme, tree),
  };
}
export function resourceBuildArtifact(): BuildArtifact {
  const bytes = Buffer.from("<h1>Native fixture</h1>");
  return {
    protocol: 1,
    bytes: bytes.length,
    files: [
      { path: "index.html", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") },
    ],
  };
}
