import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./suites.json" with { type: "json" };

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2),
  group = args[0] || "verify",
  requested = args.slice(1);
const directory = resolve(
  root,
  ".artifacts/verification",
  new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid,
);
const unit = readdirSync(resolve(root, "tests"))
  .filter((name) => name.endsWith(".test.ts") && !name.includes(".integration."))
  .sort();
const integration = readdirSync(resolve(root, "tests"))
  .filter((name) => name.endsWith(".integration.test.ts"))
  .sort();
const entries = {
  catalogs: [{ name: "i18n-contracts", command: ["run", "check:i18n"] }],
  check: [{ name: "check", command: ["run", "check"] }],
  build: [{ name: "build-client", command: ["run", "build:client"] }],
  unit: [{ name: "unit", command: ["test", ...unit.map((name) => "tests/" + name)], timeout: 120000 }],
  integration: [
    { name: "integration", command: ["test", ...integration.map((name) => "tests/" + name)], timeout: 120000 },
  ],
};
const browser = (names) => names.map((name) => ({ name, command: ["tests/" + name], timeout: 90000 }));
for (const [key, names] of Object.entries(manifest.groups)) entries[key] = browser(names);
entries.browser = browser(manifest.browser);
entries.live = browser(manifest.live.map((entry) => entry.file));
entries.tooling = browser(manifest.tooling.map((entry) => entry.file));
if (group === "tooling" && process.env.PANDA_FORCE_TOOLING_TESTS !== "1")
  throw Error("Tooling diagnostics require PANDA_FORCE_TOOLING_TESTS=1 and modify disposable development files.");
if (group === "live" && process.env.PANDA_FORCE_LIVE_TESTS !== "1")
  throw Error("Live diagnostics require PANDA_FORCE_LIVE_TESTS=1 and the configuration described in suites.json.");
if (!["verify", ...Object.keys(entries)].includes(group)) throw Error("Unknown test group: " + group);
if (requested.some((name) => !entries[group]?.some((entry) => entry.name === name)))
  throw Error("Unknown suite selection");
const eligible = readdirSync(resolve(root, "tests")).filter(
  (name) =>
    name.endsWith(".e2e.mjs") ||
    [
      "browser-smoke.mjs",
      "surfaces-browser.mjs",
      "mobile-layout.test.mjs",
      "approval-e2e.mjs",
      "review-api-e2e.mjs",
    ].includes(name),
);
const classified = [
  ...manifest.browser,
  ...manifest.live.map((entry) => entry.file),
  ...manifest.tooling.map((entry) => entry.file),
];
for (const name of eligible) if (!classified.includes(name)) throw Error("Unclassified browser suite: " + name);
if (new Set(classified).size !== classified.length) throw Error("Duplicate suite classification");
mkdirSync(directory, { recursive: true });
const planned =
  group === "verify"
    ? ["i18n-contracts", "check", "build-client", "unit", "integration", ...manifest.browser]
    : entries[group].filter((entry) => !requested.length || requested.includes(entry.name)).map((entry) => entry.name);
const result = {
  group,
  planned,
  startedAt: new Date().toISOString(),
  suites: [],
  excluded: group === "verify" ? [...manifest.live, ...manifest.tooling] : [],
};
const running = new Set();
function signal(child, name) {
  try {
    process.kill(-child.pid, name);
  } catch {}
}
async function run(entry) {
  const log = resolve(directory, entry.name.replace(/[^\w.-]/g, "_") + ".log"),
    fd = openSync(log, "w"),
    started = Date.now();
  const child = spawn(process.execPath, entry.command, {
    cwd: root,
    stdio: ["ignore", fd, fd],
    detached: true,
    env: { ...process.env, PANDA_FORCE_TEST_RUN: directory },
  });
  running.add(child);
  let timedOut = false,
    force;
  const timeout = setTimeout(() => {
    timedOut = true;
    signal(child, "SIGTERM");
    force = setTimeout(() => signal(child, "SIGKILL"), 2000);
  }, entry.timeout || 120000);
  const status = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error: error.message }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timeout);
  clearTimeout(force);
  running.delete(child);
  signal(child, "SIGTERM");
  closeSync(fd);
  const registry = resolve(directory, "fixtures.jsonl");
  if (existsSync(registry))
    for (const line of readFileSync(registry, "utf8").trim().split("\n").filter(Boolean)) {
      const fixture = JSON.parse(line),
        path = resolve(fixture.path);
      // Only this suite's registered temporary application directory is eligible.
      if (
        fixture.owner === child.pid &&
        path.startsWith(resolve(root, ".artifacts") + "/app-fixture-") &&
        !path.slice(resolve(root, ".artifacts").length + 1).includes("/")
      )
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  const record = { name: entry.name, ...status, timedOut, durationMs: Date.now() - started, log };
  result.suites.push(record);
  writeFileSync(resolve(directory, "results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`${status.code === 0 && !timedOut ? "PASS" : "FAIL"} ${entry.name} (${record.durationMs}ms)`);
  if (status.code !== 0 || timedOut) console.error(readFileSync(log, "utf8").slice(-4000));
  return status.code === 0 && !timedOut;
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    for (const child of running) signal(child, "SIGTERM");
    process.exit(130);
  });
let passed = true;
if (group === "verify") {
  for (const phase of ["catalogs", "check", "build", "unit", "integration"]) {
    for (const entry of entries[phase]) passed = (await run(entry)) && passed;
    if (!passed) break;
  }
  if (passed)
    for (let i = 0; i < entries.browser.length; i += 2) {
      const outcomes = await Promise.all(entries.browser.slice(i, i + 2).map(run));
      passed = outcomes.every(Boolean) && passed;
    }
} else {
  // Every browser entry builds its assets once, before any suite starts.
  if (["browser", ...Object.keys(manifest.groups)].includes(group)) passed = await run(entries.build[0]);
  if (passed)
    for (const entry of entries[group].filter((entry) => !requested.length || requested.includes(entry.name)))
      passed = (await run(entry)) && passed;
}
result.finishedAt = new Date().toISOString();
result.passed = passed;
result.notRun = planned.filter((name) => !result.suites.some((suite) => suite.name === name));
writeFileSync(resolve(directory, "results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`Results: ${resolve(directory, "results.json")}`);
if (result.excluded.length)
  console.log(
    `Excluded ${result.excluded.length} explicit live/tooling diagnostics; see suites.json for requirements.`,
  );
process.exitCode = passed ? 0 : 1;
