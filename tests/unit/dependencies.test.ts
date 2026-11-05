import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inspectDependencies } from "../../scripts/quality/dependencies.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function graph(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "panda-dependencies-"));
  directories.push(root);
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return inspectDependencies(root);
}
test("runtime cycles are rejected while explicit type recursion is reported separately", () => {
  const runtime = graph({ "client/a.ts": 'import "./b.js";', "client/b.ts": 'void import("./a.js");' });
  expect(runtime.runtimeCycles).toEqual([["client/a.ts", "client/b.ts"]]);
  const types = graph({
    "client/a.ts": 'import type {B} from "./b.js";export interface A {b:B}',
    "client/b.ts": 'import type {A} from "./a.js";export interface B {a:A}',
  });
  expect(types.runtimeCycles).toEqual([]);
  expect(types.typeCycles).toHaveLength(1);
});
test("transport inversion and cross-runtime imports cannot pass as type-only dependencies", () => {
  const result = graph({
    "shared/value.ts": 'import type {Secret} from "../server/auth/session.js";',
    "server/auth/session.ts": "export type Secret=string;",
    "server/projects/store.js": 'import "../http/routes.js";',
    "server/http/routes.js": "export {};",
    "client/view.js": 'import "../server/auth/session.js";',
  });
  expect(result.violations).toHaveLength(3);
  expect(result.violations.map((row) => row.from).sort()).toEqual([
    "client/view.js",
    "server/projects/store.js",
    "shared/value.ts",
  ]);
  const privateRoot = mkdtempSync(join(tmpdir(), "panda-private-import-"));
  directories.push(privateRoot);
  const source = join(privateRoot, "src");
  mkdirSync(join(source, "client"), { recursive: true });
  mkdirSync(join(source, "shared"));
  writeFileSync(join(privateRoot, "private.json"), '{"secret":"fixture-only"}');
  writeFileSync(join(source, "client", "view.ts"), 'import data from "../../private.json";');
  writeFileSync(join(source, "shared", "portable.ts"), 'import type { Stats } from "node:fs";');
  const privateImports = inspectDependencies(source);
  expect(privateImports.missing).toHaveLength(1);
  expect(privateImports.violations).toHaveLength(1);
});
test("feature peers are injected and terminal workers cannot pull in the session owner", () => {
  const result = graph({
    "client/application/one.js": 'import "./two.js";export function assembleOne(){}',
    "client/application/two.js": "export function assembleTwo(){}",
    "server/terminal/worker.js": 'import "./session.js";',
    "server/terminal/session.js": "export {};",
    "client/conversation-repository.js": 'import "./conversation-cache.js";',
    "client/conversation-cache.js": "export {};",
  });
  expect(result.violations).toHaveLength(3);
});
