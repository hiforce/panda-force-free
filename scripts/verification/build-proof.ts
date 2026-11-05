import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCompleteVerification } from "./contracts.js";
import { sourceIdentity } from "./source.js";

/** The runtime image can only copy artifacts from a build that completed the entire verification plan. */
const directory = resolve(".build-proof");
mkdirSync(directory, { recursive: true });
const resultFile = resolve(directory, "results.json");
rmSync(resultFile, { force: true });
rmSync(resolve(directory, "verification.json"), { force: true });
const before = sourceIdentity();
const child = Bun.spawn([process.execPath, "scripts/testing/run.mjs", "verify"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, PANDA_FORCE_VERIFY_RESULT: resultFile },
});
if ((await child.exited) !== 0) throw new Error("Verification failed; no image proof was produced");
const result: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
assertCompleteVerification(result);
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
