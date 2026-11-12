import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cdnConfiguration, s3Storage } from "./storage.mjs";
import { collectAssets, publishAssets, writeCdnOutput } from "./publish.mjs";

export async function buildCdn() {
  const config = cdnConfiguration();
  if (!config) throw new Error("PANDA_FORCE_CDN_BASE_URL is required");
  const staging = mkdtempSync(join(tmpdir(), "panda-static-"));
  // Remove any previous activation before network work; a failed build cannot reuse it.
  const output = resolve("dist/cdn-public");
  rmSync(output, { recursive: true, force: true });
  try {
    cpSync("public", staging, { recursive: true, filter: (path) => !path.endsWith("cdn-manifest.json") });
    for (const [source, target] of [
      ["katex/dist", "vendor/katex"],
      ["@xterm/xterm/css", "vendor/xterm"],
    ]) {
      const destination = join(staging, target);
      mkdirSync(destination, { recursive: true });
      cpSync(resolve("node_modules", source), destination, {
        recursive: true,
        filter: (path) => !path.endsWith(".map") && !path.endsWith(".html") && !path.endsWith(".md"),
      });
    }
    // Every file emitted into public is collected, including feature-specific chunks.
    const assets = new Map(collectAssets(staging));
    const manifest = await publishAssets({ assets, storage: s3Storage(config), ...config });
    writeCdnOutput({ source: staging, output, manifest });
    if (!existsSync(join(output, "index.html"))) throw new Error("CDN entry point was not generated");
    console.log(
      `CDN verified: ${Object.keys(manifest.assets).length} assets, ${manifest.uploaded} uploaded, ${manifest.reused} reused`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
