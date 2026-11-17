import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sourceIdentity } from "../verification/source.js";
import { renderCdnDockerfile } from "./cdn-image.js";
export { renderCdnDockerfile } from "./cdn-image.js";

/** Prepare a reusable source-matched CDN recipe without owning upload or deployment credentials. */
export function prepareCdnImage(argv = process.argv) {
  const argument = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0 || !argv[index + 1]) throw Error("Missing " + name);
    return argv[index + 1];
  };
  const gitOptions = ["-c", "safe.directory=" + process.cwd()];
  execFileSync("git", [...gitOptions, "diff", "--quiet", "HEAD"]);
  const commit = execFileSync("git", [...gitOptions, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dockerfile = renderCdnDockerfile({
    repository: argument("--repository"),
    baseUrl: argument("--base-url"),
    commit,
    sourceSha256: sourceIdentity().sha256,
    prefix: argv.includes("--prefix") ? argument("--prefix") : "pandaforce/static",
    configurationKey: argv.includes("--configuration-key") ? argument("--configuration-key") : undefined,
  });
  const output = ".spark/cdn/Dockerfile";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, dockerfile);
  console.log(
    "CDN mode verifies the current source fingerprint for checkout " +
      commit +
      ". Prepare and publish the CDN source artifact before pushing this source; local-only fallback is disabled.",
  );
}

if (import.meta.main) prepareCdnImage();
