import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceIdentity } from "../../scripts/verification/source.js";
import { assertCompleteVerification } from "../../scripts/verification/contracts.js";
import { verificationPlan } from "../../scripts/testing/verification-plan.js";

test("authenticated live diagnostics refuse to run without an explicit opt-in", () => {
  const run = Bun.spawnSync([process.execPath, "scripts/testing/run.mjs", "live", "app-server.live.test.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, PANDA_FORCE_LIVE_TESTS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("Live diagnostics require PANDA_FORCE_LIVE_TESTS=1");
});

test("release evidence rejects partial, failed, duplicated or timed out verification", () => {
  const passing = {
    group: "verify",
    passed: true,
    planned: [...verificationPlan],
    notRun: [],
    startedAt: "2026-11-05T00:00:00Z",
    finishedAt: "2026-11-05T00:01:00Z",
    suites: verificationPlan.map((name) => ({ name, code: 0, timedOut: false })),
  };
  expect(() => assertCompleteVerification(passing)).not.toThrow();
  for (const changed of [
    { passed: false },
    { group: "browser" },
    { notRun: ["unit"] },
    { suites: passing.suites.slice(1) },
    { planned: passing.planned.slice(1) },
    { suites: passing.suites.map((suite, i) => (i === 1 ? passing.suites[0] : suite)) },
    { suites: passing.suites.map((suite, i) => (i === 0 ? { ...suite, timedOut: true } : suite)) },
    { suites: passing.suites.map((suite, i) => (i === 0 ? { ...suite, code: 1 } : suite)) },
    { finishedAt: "2026-11-04T23:59:00Z" },
  ])
    expect(() => assertCompleteVerification({ ...passing, ...changed })).toThrow("Incomplete");
});

test("source identity binds code, dependency patches and executable modes while ignoring build output", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-source-proof-"));
  try {
    for (const name of ["src", "patches", "public", "dist"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src", "main.ts"), "export const value = 1;");
    writeFileSync(join(root, "patches", "dependency.patch"), "initial");
    const initial = sourceIdentity(root).sha256;
    writeFileSync(join(root, "dist", "server.js"), "generated");
    writeFileSync(join(root, "public", "app.bundle.js"), "generated");
    expect(sourceIdentity(root).sha256).toBe(initial);
    writeFileSync(join(root, "patches", "dependency.patch"), "changed");
    const changed = sourceIdentity(root).sha256;
    expect(changed).not.toBe(initial);
    for (const stylesheet of ["workbench-chrome.css", "workbench-layout.css", "appearance.css"]) {
      const beforeStylesheet = sourceIdentity(root).sha256;
      writeFileSync(join(root, "public", stylesheet), "body { color: #222; }");
      expect(sourceIdentity(root).sha256).not.toBe(beforeStylesheet);
    }
    chmodSync(join(root, "src", "main.ts"), 0o755);
    expect(sourceIdentity(root).sha256).not.toBe(changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
