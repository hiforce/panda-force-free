import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sourceIdentity } from "../verification/source.js";
import { dependencyProfile } from "./dependencies.mjs";
import { existsSync } from "node:fs";
import { inputDigest } from "./creative-tools.mjs";

/** Application packaging and explicitly requested regression proofs have separate outcomes. */
const expected = JSON.parse(readFileSync("scripts/build/base-images.json", "utf8"));
if (dependencyProfile(process.cwd()) !== expected.inputsSha256)
  throw new Error("Dependency profile changed; publish and select matching build/runtime bases before packaging.");
if (
  expected.mediaRecipeSha256 &&
  createHash("sha256").update(readFileSync("scripts/build/Dockerfile.media-bases")).digest("hex") !==
    expected.mediaRecipeSha256
)
  throw new Error("Media base recipe changed; publish and select matching bases before packaging.");
for (const [path, key] of [
  ["scripts/build/Dockerfile.engine-bases", "engineRecipeSha256"],
  ["scripts/build/harness-engines.lock.json", "engineLockSha256"],
] as const) {
  if (expected[key] && createHash("sha256").update(readFileSync(path)).digest("hex") !== expected[key])
    throw new Error("Harness engine inputs changed; rebuild and select matching bases before packaging.");
}
if (
  expected.engineLockSha256 &&
  process.env.PANDA_FORCE_BUILD_BASE &&
  createHash("sha256").update(readFileSync("/opt/panda-harness/engines.json")).digest("hex") !==
    expected.engineLockSha256
)
  throw new Error("Build base Harness versions do not match the reviewed lock.");
const profile = process.env.PANDA_FORCE_VERIFICATION_PROFILE || "none";
const creativeInputs = "/opt/panda-creative/inputs";
const creativeToolchain = existsSync(creativeInputs)
  ? { platform: "rocky9", inputsSha256: inputDigest("scripts/build/creative-tools") }
  : undefined;
if (creativeToolchain && creativeToolchain.inputsSha256 !== inputDigest(creativeInputs))
  throw new Error("Creative toolchain inputs changed; rebuild both Rocky bases before packaging.");
if (!["none", "full", "brand", "cdn"].includes(profile)) throw new Error("Unknown verification profile: " + profile);
rmSync(".build-info", { recursive: true, force: true });
const source = sourceIdentity();
const command = profile === "none" ? ["run", "build:client"] : ["run", "release:proof"];
const child = Bun.spawn([process.execPath, ...command], { stdout: "inherit", stderr: "inherit" });
if ((await child.exited) !== 0) throw new Error("Application build failed");
if (sourceIdentity().sha256 !== source.sha256) throw new Error("Source changed during application packaging");
mkdirSync(".build-info", { recursive: true });
if (profile !== "none") {
  const proof = JSON.parse(readFileSync(".build-proof/verification.json", "utf8"));
  if (proof.source.sha256 !== source.sha256 || !proof.verification.passed || proof.verificationProfile !== profile)
    throw new Error("Requested verification did not produce a matching source proof");
  writeFileSync(".build-info/verification.json", JSON.stringify(proof, null, 2) + "\n");
}
writeFileSync(
  ".build-info/build-info.json",
  JSON.stringify(
    {
      schema: 1,
      mode: "application-fast",
      builtAt: new Date().toISOString(),
      source,
      bases: {
        ...expected,
        buildBase: process.env.PANDA_FORCE_BUILD_BASE || expected.buildBase,
        runtimeBase: process.env.PANDA_FORCE_RUNTIME_BASE || expected.runtimeBase,
        ...(creativeToolchain ? { creativeToolchain } : {}),
      },
      verification:
        profile === "none"
          ? { status: "not-run", manualCommand: "bun run release:proof" }
          : { status: "passed", profile, fullVerification: profile === "full" },
    },
    null,
    2,
  ) + "\n",
);
console.log("Application build source: " + source.sha256);
console.log(
  profile === "none"
    ? "Application packaging complete; regression tests run separately."
    : "Requested verification profile passed: " + profile,
);
