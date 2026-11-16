import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDependencies } from "../../scripts/quality/dependencies.mjs";

function graph(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "panda-skill-architecture-"));
  try {
    for (const [path, value] of Object.entries(files)) {
      const destination = join(root, path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, value);
    }
    return inspectDependencies(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("skill domain cannot acquire feature installers or native protocol dependencies through type imports", () => {
  const inspected = graph({
    "shared/skills/task.ts": "import type { Manifest } from '../plugins/manifest.js'; export type Use = Manifest;",
    "shared/plugins/manifest.ts": "export interface Manifest { id:string }",
  });
  expect(inspected.missing).toEqual([]);
  expect(inspected.violations.length).toBe(1);
  expect(inspected.violations[0]!.reason).toContain("Skill contracts");
});
test("neutral package primitives cannot import a skill manifest", () => {
  const inspected = graph({
    "shared/packages/digest.ts": "import type { Manifest } from '../skills/contracts.js'; export type Use = Manifest;",
    "shared/skills/contracts.ts": "export interface Manifest { id:string }",
  });
  expect(inspected.violations.length).toBe(1);
  expect(inspected.violations[0]!.reason).toContain("Neutral package primitives");
});
test("theme and skill packages may independently use the same content identity primitive", () => {
  const inspected = graph({
    "shared/plugins/validation.ts": "export { digest } from '../packages/digest.js';",
    "shared/skills/resources.ts": "export { digest } from '../packages/digest.js';",
    "shared/packages/digest.ts": "export const digest = 'content';",
  });
  expect(inspected.violations).toEqual([]);
  expect(inspected.runtimeCycles).toEqual([]);
  expect(inspected.typeCycles).toEqual([]);
});
test("skill services cannot select concrete storage through executable or type imports", () => {
  const inspected = graph({
    "server/skills/catalog/service.ts": "import type { Store } from '../storage/repository.js'; export type Use=Store;",
    "server/skills/storage/repository.ts": "export interface Store { revision:number }",
  });
  expect(inspected.violations.length).toBe(1);
  expect(inspected.violations[0]!.reason).toContain("concrete databases");
});
test("neutral file storage cannot depend on skill metadata or application services", () => {
  const inspected = graph({
    "server/packages/content-store.ts":
      "import type { Skill } from '../../shared/skills/contracts.js'; export type Use=Skill;",
    "shared/skills/contracts.ts": "export interface Skill { id:string }",
  });
  expect(inspected.violations.length).toBe(1);
  expect(inspected.violations[0]!.reason).toContain("without feature contracts");
});
