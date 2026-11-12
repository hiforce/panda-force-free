import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCompleteVerification } from "./contracts.js";
import { verificationPlan } from "../testing/verification-plan.js";
import { sourceIdentity } from "./source.js";

/** Record the selected verification scope and never certify a targeted run as a full run. */
const directory = resolve(".build-proof");
mkdirSync(directory, { recursive: true });
const resultFile = resolve(directory, "results.json");
rmSync(resultFile, { force: true });
rmSync(resolve(directory, "verification.json"), { force: true });
const before = sourceIdentity();
const profile = process.env.PANDA_FORCE_VERIFICATION_PROFILE || "full";
if (!["full", "brand", "cdn"].includes(profile)) throw new Error("Unknown verification profile: " + profile);
if (profile === "full") {
  const child = Bun.spawn([process.execPath, "scripts/testing/run.mjs", "verify"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PANDA_FORCE_VERIFY_RESULT: resultFile },
  });
  if ((await child.exited) !== 0) throw new Error("Verification failed; no image proof was produced");
  const result: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
  assertCompleteVerification(result);
} else {
  const startedAt = new Date().toISOString();
  const suites = [];
  const plan =
    profile === "cdn"
      ? [
          { name: "build-client", args: ["run", "build:client"], env: {} },
          {
            name: "cdn-unit",
            args: ["test", "tests/unit/cdn-build.test.ts", "tests/unit/static-assets.test.ts"],
            env: {},
          },
          { name: "cdn-assets.e2e.mjs", args: ["tests/browser/cdn-assets.e2e.mjs"], env: {} },
        ]
      : [
          { name: "build-client", args: ["run", "build:client"], env: {} },
          {
            name: "brand-unit",
            args: [
              "test",
              "tests/unit/codex-icons.test.ts",
              "tests/unit/product-brand.test.ts",
              "tests/unit/build-proof.test.ts",
            ],
            env: {},
          },
          { name: "mobile-install.e2e.mjs", args: ["tests/browser/mobile-install.e2e.mjs"], env: {} },
          {
            name: "mobile-install-webkit.e2e.mjs",
            args: ["tests/browser/mobile-install.e2e.mjs"],
            env: { PANDA_FORCE_TEST_BROWSER: "webkit" },
          },
        ];
  for (const suite of plan) {
    const child = Bun.spawn([process.execPath, ...suite.args], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...suite.env },
    });
    const code = await child.exited;
    suites.push({ name: suite.name, code, timedOut: false });
    if (code !== 0) throw new Error("Targeted verification failed: " + suite.name);
  }
  writeFileSync(
    resultFile,
    JSON.stringify(
      {
        group: profile,
        passed: true,
        fullVerification: false,
        planned: plan.map((suite) => suite.name),
        suites,
        notRun: verificationPlan.filter((name) => !plan.some((suite) => suite.name === name)),
        startedAt,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
const result = JSON.parse(readFileSync(resultFile, "utf8"));
const after = sourceIdentity();
if (after.sha256 !== before.sha256)
  throw new Error("Source changed during verification; repeat the complete verification");
const postgresRoot = "/usr/lib/postgresql";
const postgres = existsSync(postgresRoot)
  ? readdirSync(postgresRoot)
      .map((version) => postgresRoot + "/" + version + "/bin/postgres")
      .find(existsSync)
  : undefined;
const version = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();
const proof = {
  schema: 1,
  verificationProfile: profile,
  source: after,
  verifiedAt: new Date().toISOString(),
  tools: {
    bun: Bun.version,
    node: version("node", ["--version"]),
    codex: version("codex", ["--version"]),
    ...(postgres ? { postgres: version(postgres, ["--version"]) } : {}),
  },
  verification: result,
};
writeFileSync(resolve(directory, "verification.json"), JSON.stringify(proof, null, 2) + "\n");
console.log("Verified source identity: " + proof.source.sha256);
