import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readServiceLogConfig } from "../../src/server/logging/config.js";
import { createRotatingLog } from "../../src/server/logging/rotating-file.js";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "panda-log-"));
  temporary.push(path);
  return path;
}
function segments(path) {
  return readdirSync(path).filter((name) => /^panda-force-.*\.log$/.test(name));
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("a standalone start creates private persistent logging configuration without Kubernetes", () => {
  const root = directory(),
    settings = readServiceLogConfig({ HOME: root });
  expect(settings).toMatchObject({
    enabled: true,
    directory: join(root, ".panda-force/logs"),
    maxFileBytes: 10485760,
    maxFiles: 10,
  });
  expect(JSON.parse(readFileSync(settings.configFile, "utf8"))).toMatchObject({
    version: 1,
    logging: { maxFiles: 10 },
  });
  expect(statSync(settings.configFile).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, ".panda-force/config")).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(root, ".panda-force/config"))).toEqual(["panda-force.json"]);
});

test("file settings survive restarts and optional environment overrides do not rewrite them", () => {
  const root = directory(),
    settings = readServiceLogConfig({ PANDA_FORCE_HOME: root });
  const content = JSON.stringify({
    version: 1,
    logging: { directory: "../custom-logs", maxFileBytes: 2048, maxFiles: 3 },
  });
  writeFileSync(settings.configFile, content);
  expect(readServiceLogConfig({ PANDA_FORCE_HOME: root })).toMatchObject({
    directory: join(root, "custom-logs"),
    maxFileBytes: 2048,
    maxFiles: 3,
  });
  expect(
    readServiceLogConfig({ PANDA_FORCE_HOME: root, PANDA_FORCE_LOG_MAX_FILES: "5", PANDA_FORCE_LOG_ENABLED: "false" }),
  ).toMatchObject({ maxFiles: 5, enabled: false });
  expect(readFileSync(settings.configFile, "utf8")).toBe(content);
});

test("invalid JSON, limits and unknown logging options fail with useful configuration errors", () => {
  const root = directory(),
    settings = readServiceLogConfig({ PANDA_FORCE_HOME: root });
  for (const logging of [
    { maxFileBytes: 0 },
    { maxFiles: 0 },
    { maxFiles: 1.5 },
    { maxFiles: 1001 },
    { directory: "" },
    { enabled: "yes" },
    { maxFiels: 3 },
  ]) {
    writeFileSync(settings.configFile, JSON.stringify({ version: 1, logging }));
    expect(() => readServiceLogConfig({ PANDA_FORCE_HOME: root })).toThrow();
  }
  writeFileSync(settings.configFile, "{invalid");
  expect(() => readServiceLogConfig({ PANDA_FORCE_HOME: root })).toThrow("Invalid PandaForce JSON");
});

test("rotation bounds every file and the global file count across service restarts", () => {
  const path = directory();
  writeFileSync(join(path, "operator-notes.txt"), "Keep this file");
  for (let run = 0; run < 5; run++) {
    const writer = createRotatingLog({ directory: path, maxFileBytes: 1024, maxFiles: 3 });
    for (let line = 0; line < 8; line++) writer.write(`${run}:${line}:` + "a".repeat(700) + "\n");
    expect(segments(path).length).toBeLessThanOrEqual(3);
    expect(segments(path).every((name) => statSync(join(path, name)).size <= 1024)).toBe(true);
    expect(readFileSync(join(path, "panda-force.log"), "utf8")).toContain(`${run}:7:`);
  }
  expect(readFileSync(join(path, "operator-notes.txt"), "utf8")).toBe("Keep this file");
  expect(lstatSync(join(path, "panda-force.log")).isSymbolicLink()).toBe(true);
  expect(statSync(join(path, readlinkSync(join(path, "panda-force.log")))).mode & 0o777).toBe(0o600);
});

test("oversized Unicode output is split into bounded UTF-8 segments without losing characters", () => {
  const path = directory(),
    writer = createRotatingLog({ directory: path, maxFileBytes: 1024, maxFiles: 100 });
  const text = "日志😀".repeat(1000);
  writer.write(text);
  let bytes = 0;
  for (const name of segments(path)) {
    const content = readFileSync(join(path, name));
    bytes += content.length;
    expect(content.length).toBeLessThanOrEqual(1024);
    expect(content.toString("utf8")).not.toContain("�");
  }
  expect(bytes).toBe(Buffer.byteLength(text));
});

test("overlapping writers recover a pruned segment and never touch unrelated files", () => {
  const path = directory(),
    options = { directory: path, maxFileBytes: 1024, maxFiles: 2 };
  const old = createRotatingLog(options);
  old.write("old service\n");
  for (let i = 0; i < 6; i++) createRotatingLog(options).write("new service\n");
  old.write("old service shutdown\n");
  expect(segments(path).length).toBeLessThanOrEqual(2);
  expect(readFileSync(join(path, "panda-force.log"), "utf8")).toContain("old service shutdown");
});

test("the current log follows the last writer even when an older segment is retained", () => {
  const path = directory(),
    options = { directory: path, maxFileBytes: 1024, maxFiles: 10, now: () => new Date("2026-11-05T00:00:00Z") };
  const first = createRotatingLog(options);
  first.write("first service\n");
  const second = createRotatingLog(options);
  second.write("second service\n");
  first.write("first service shutdown\n");
  expect(segments(path)).toHaveLength(2);
  expect(readFileSync(join(path, "panda-force.log"), "utf8")).toContain("first service shutdown");
  second.write("second service resumed\n");
  expect(readFileSync(join(path, "panda-force.log"), "utf8")).toContain("second service resumed");
});

test("reducing rotation limits retires oversized historical files", () => {
  const path = directory();
  createRotatingLog({ directory: path, maxFileBytes: 4096, maxFiles: 10 }).write("a".repeat(3000));
  createRotatingLog({ directory: path, maxFileBytes: 1024, maxFiles: 2 }).write("new limit\n");
  expect(segments(path).length).toBeLessThanOrEqual(2);
  expect(segments(path).every((name) => statSync(join(path, name)).size <= 1024)).toBe(true);
});

test("an unmanaged active log file is preserved instead of overwritten", () => {
  const path = directory(),
    other = join(path, "other.log");
  writeFileSync(other, "Keep this file");
  symlinkSync("other.log", join(path, "panda-force.log"));
  expect(() => createRotatingLog({ directory: path, maxFileBytes: 1024, maxFiles: 2 })).toThrow("managed log link");
  expect(readFileSync(other, "utf8")).toBe("Keep this file");
});
