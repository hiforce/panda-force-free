import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inspectDependencies } from "../../scripts/quality/dependencies.mjs";

const directories: string[] = [];
test("knowledge workflows cannot acquire concrete storage, transport or native task authority", () => {
  const result = graph({
    "server/knowledge/tasks/service.ts":
      'import "../storage/records.js";import type {Content} from "../integration/files.js";',
    "server/knowledge/tasks/raw.ts": 'import {Database} from "bun:sqlite";',
    "server/knowledge/tasks/contracts.ts": "export interface Task {}",
    "server/knowledge/storage/records.ts": 'import "../tasks/service.js";',
    "server/knowledge/integration/files.ts": "export interface Content {}",
    "server/knowledge/integration/feature.ts": 'import "../storage/records.js";',
    "server/engines/application-tools/adapter.ts": 'import type {Task} from "../../knowledge/tasks/contracts.js";',
  });
  expect(result.missing).toEqual([]);
  expect(result.violations.map((value) => value.from).sort()).toEqual(
    [
      "server/engines/application-tools/adapter.ts",
      "server/knowledge/storage/records.ts",
      "server/knowledge/tasks/raw.ts",
      "server/knowledge/tasks/service.ts",
      "server/knowledge/tasks/service.ts",
    ].sort(),
  );
});

test("backend responsibility detection combines independent concentration signals instead of a file-length rule", () => {
  const manyMethods = Array.from({ length: 16 }, (_, i) => `action${i}(){return ${i}}`).join(""),
    dependencies = Array.from({ length: 8 }, (_, i) => `private d${i}: unknown`).join(",");
  const result = graph({
    "server/knowledge/tasks/concentrated.ts": `export class Concentrated {constructor(${dependencies}){}${manyMethods}}`,
    "server/knowledge/tasks/padded.ts": `export class Cohesive {${"\n".repeat(280)}execute(){return true}}`,
  });
  expect(result.structure.violations.map((value) => value.name)).toEqual(["Concentrated"]);
  expect(result.structure.violations[0]!.lines).toBe(1);
  expect(result.structure.classes.find((value) => value.name === "Cohesive")!.lines).toBeGreaterThan(260);
});
test("knowledge generation persistence may use its neutral port but cannot acquire rule workflows", () => {
  const result = graph({
    "server/knowledge/generation/contracts.ts": "export interface Jobs {}",
    "server/knowledge/generation/service.ts": 'import type {Store} from "../storage/policies.js";',
    "server/knowledge/generation/selection.ts": "export const choose = () => [];",
    "server/knowledge/storage/policies.ts":
      'import type {Jobs} from "../generation/contracts.js";import "../generation/selection.js";export interface Store {}',
  });
  expect(result.missing).toEqual([]);
  expect(result.violations.map((value) => value.from).sort()).toEqual([
    "server/knowledge/generation/service.ts",
    "server/knowledge/storage/policies.ts",
  ]);
});
test("creation workflows, persistence and provider adapters retain independent application boundaries", () => {
  const result = graph({
    "server/creation/outputs.ts":
      'import type {Navigation} from "../documents/files/navigation.js";import "./storage/repository.js";',
    "server/documents/files/navigation.ts": 'import "../../creation/contracts.js";export interface Navigation {}',
    "server/creation/storage/repository.ts": 'import "../document-tools.js";',
    "server/creation/document-tools.ts": 'import type {Engine} from "../../shared/engine/application-tools.js";',
    "shared/engine/application-tools.ts": "export interface Engine {}",
    "server/engines/application-tools/codex.ts": 'import "../../creation/contracts.js";',
    "server/creation/contracts.ts": "export {};",
    "server/creation/integration/document-output.ts":
      'import type {Navigation} from "../../documents/files/navigation.js";',
  });
  expect(result.missing).toEqual([]);
  expect(result.violations.map((row) => row.from + " -> " + row.to).sort()).toEqual(
    [
      "server/creation/outputs.ts -> server/creation/storage/repository.ts",
      "server/creation/outputs.ts -> server/documents/files/navigation.ts",
      "server/creation/storage/repository.ts -> server/creation/document-tools.ts",
      "server/documents/files/navigation.ts -> server/creation/contracts.ts",
      "server/engines/application-tools/codex.ts -> server/creation/contracts.ts",
    ].sort(),
  );
});
test("immutable version policies and native command ports do not select another format or concrete storage", () => {
  const result = graph({
    "server/packages/versions/registry.ts": 'import type {Theme} from "../../templates/native/ports.js";',
    "server/slides/templates/service.ts": 'import "../storage/registry.js";import "../../templates/native/service.js";',
    "server/slides/storage/registry.ts": "export {};",
    "server/templates/native/service.ts": "export {};",
    "server/templates/native/ports.ts": "export interface Theme {}",
  });
  expect(result.violations.map((v) => v.from + " -> " + v.to).sort()).toEqual(
    [
      "server/packages/versions/registry.ts -> server/templates/native/ports.ts",
      "server/slides/templates/service.ts -> server/slides/storage/registry.ts",
      "server/slides/templates/service.ts -> server/templates/native/service.ts",
    ].sort(),
  );
});
test("source ownership adapters have no template or native Office authority", () => {
  const result = graph({
    "server/packages/ownership/staged.ts": 'import type {Theme} from "../../templates/native/ports.js";',
    "server/packages/ownership/contracts.ts": 'import type {Slide} from "../../../shared/slides/contracts.js";',
    "server/templates/native/ports.ts": "export interface Theme {}",
    "shared/slides/contracts.ts": "export interface Slide {}",
  });
  expect(result.violations.map((row) => row.from).sort()).toEqual([
    "server/packages/ownership/contracts.ts",
    "server/packages/ownership/staged.ts",
  ]);
});
test("Office package primitives are independent of presentation features and installation authority", () => {
  const result = graph({
    "server/packages/opc/package.ts": 'import "../../slides/office/package.js";import "./xml.js";',
    "server/packages/opc/xml.ts": 'import type {Identity} from "../../templates/native/service.js";',
    "server/packages/opc/edit.ts": 'import type {Slide} from "../../../shared/slides/contracts.js";',
    "server/slides/office/package.ts": 'import "../../packages/opc/uris.js";',
    "server/packages/opc/uris.ts": 'import "../../../shared/packages/sources/contracts.js";',
    "server/templates/native/service.ts": "export interface Identity {}",
    "shared/packages/sources/contracts.ts": "export {};",
    "shared/slides/contracts.ts": "export interface Slide {}",
  });
  expect(result.violations.map((row) => row.from).sort()).toEqual([
    "server/packages/opc/edit.ts",
    "server/packages/opc/package.ts",
    "server/packages/opc/xml.ts",
  ]);
});
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
test("active source services cannot depend on offline cutover orchestration", () => {
  const result = graph({
    "server/documents/service.ts": 'import "../content-migration/plan.js";',
    "server/publishing/integration/source.ts": 'import type {Plan} from "../../content-migration/plan.js";',
    "server/content-migration/cli.ts": 'import "./plan.js";',
    "server/content-migration/plan.ts": "export interface Plan {}",
  });
  expect(result.violations.map((row) => row.from).sort()).toEqual([
    "server/documents/service.ts",
    "server/publishing/integration/source.ts",
  ]);
});
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

test("publishing adapters cannot leak into document ownership or portable conversion", () => {
  const result = graph({
    "server/documents/service.ts": 'import "../publishing/service.js";',
    "server/publishing/service.ts": 'import "./adapters/x.js";',
    "server/publishing/adapters/x.ts": "export {};",
    "server/publishing/content/parse.ts": 'import "../adapters/x.js";',
    "server/publishing/store.ts": 'import "../documents/service.js";',
    "server/publishing/integration/feature.ts": 'import "../adapters/x.js";',
    "client/documents/editor.ts": 'import "../publishing/controller.js";',
    "client/publishing/controller.ts": "export {};",
  });
  expect(result.violations).toHaveLength(5);
  expect(result.violations.some((row) => row.from.includes("integration/"))).toBe(false);
});

test("publication storage stays independent of platform payloads and workflows", () => {
  const result = graph({
    "server/delivery/storage/schema.ts": 'import "../errors.js";',
    "server/delivery/storage/leases.ts": 'import "../worker.js";',
    "server/delivery/storage/effects.ts": 'import type { Payload } from "../../../shared/builds/contracts.js";',
    "server/delivery/errors.ts": "export {};",
    "server/delivery/worker.ts": "export {};",
    "shared/builds/contracts.ts": "export interface Payload {}",
  });
  expect(result.violations.map((item) => item.from).sort()).toEqual([
    "server/delivery/storage/effects.ts",
    "server/delivery/storage/leases.ts",
  ]);
});

test("OAuth consent and account services cannot import a platform adapter", () => {
  const result = graph({
    "server/connections/oauth/service.ts": 'import "../adapters/x/oauth.js";',
    "server/connections/accounts/service.ts": 'import "../adapters/x/oauth.js";',
    "server/connections/adapters/x/oauth.ts": 'import type {Provider} from "../../oauth/ports.js";',
    "server/connections/oauth/ports.ts": "export interface Provider {}",
  });
  expect(result.violations.map((item) => item.from).sort()).toEqual([
    "server/connections/accounts/service.ts",
    "server/connections/oauth/service.ts",
  ]);
});

test("plugin approval, persistence and presentation catalogs retain independent ownership", () => {
  const result = graph({
    "server/plugins/service.ts": 'import "./storage/repository.js";import "../documents/service.js";',
    "server/plugins/storage/repository.ts": 'import "../service.js";',
    "server/documents/service.ts": 'import "../plugins/service.js";',
    "server/plugins/integration/feature.ts": 'import "../storage/repository.js";import "../../documents/service.js";',
  });
  expect(result.violations).toHaveLength(4);
  expect(result.violations.some((row) => row.from.includes("integration/"))).toBe(false);
});

test("file document ownership, asynchronous HTTP ports and read-only legacy migration stay separate", () => {
  const result = graph({
    "server/documents/editor-port.ts": 'import type { Service } from "./files/service.js";',
    "server/documents/editor-routes.ts": 'import "./files/service.js";',
    "server/documents/files/service.ts":
      'import { Database } from "bun:sqlite";import "../document-repository.js";import "../../project-content/migration/legacy-documents.js";',
    "server/documents/document-repository.ts": "export {};",
    "server/project-content/migration/legacy-documents.ts": 'import { Database } from "bun:sqlite";',
    "server/project-content/store.ts": 'import "../documents/editor-routes.js";import { Database } from "bun:sqlite";',
  });
  expect(result.violations).toHaveLength(7);
  expect(result.violations.some((row) => row.from.includes("migration/"))).toBe(false);
  const valid = graph({
    "server/documents/editor-port.ts": 'import type { Source } from "../../shared/documents/source.js";',
    "shared/documents/source.ts": "export interface Source {}",
    "server/documents/editor-routes.ts": 'import type { Port } from "./editor-port.js";',
    "server/documents/files/application.ts": 'import "../editor-routes.js";import "../../project-content/project.js";',
    "server/project-content/project.ts": 'import type { Source } from "../../shared/documents/source.js";',
  });
  expect(valid.violations).toEqual([]);
});

test("only the declared deployment gadget loader may import its absolute file URL dynamically", () => {
  const result = graph({
    "server/gadget/module-loader.ts": "void import(pathToFileURL(path).href);void import(unrelated);",
    "server/gadget/feature.ts": "void import(pathToFileURL(path).href);",
  });
  expect(result.deploymentImports).toEqual([
    { from: "server/gadget/module-loader.ts", policy: "administrator-configured-absolute-file" },
  ]);
  expect(result.unsupportedDynamicImports.sort()).toEqual([
    "server/gadget/feature.ts",
    "server/gadget/module-loader.ts",
  ]);
});
