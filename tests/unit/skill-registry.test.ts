import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, stat, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { SKILL_CAPABILITIES } from "../../src/shared/skills/contracts.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { openSkillDatabase } from "../../src/server/skills/storage/database.js";
import { SqliteSkillRegistry } from "../../src/server/skills/storage/repository.js";
import { FileSkillBundles } from "../../src/server/skills/storage/bundles.js";
import { decodeSkillBundle, encodeSkillBundle, SKILL_BUNDLE_BYTES } from "../../src/server/skills/storage/codec.js";
import { SkillCatalog } from "../../src/server/skills/catalog/service.js";
import type { SkillBundleStore } from "../../src/server/skills/ports.js";
import { seedBuiltinWriting } from "../../src/server/skills/builtin/seed.js";
import { builtinWritingPack } from "../../src/server/skills/builtin/writing.js";
const roots: string[] = [],
  databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function pack(change?: (manifest: any) => void) {
  const root = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url),
    manifest = JSON.parse(readFileSync(new URL("panda-skills.json", root), "utf8"));
  const resources = manifest.files.map((path: string) => ({
    path,
    bytes: new Uint8Array(readFileSync(new URL(path, root))),
  }));
  change?.(manifest);
  return verifySkillResources(new TextEncoder().encode(JSON.stringify(manifest)), resources);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-skills-registry-"));
  roots.push(root);
  const path = join(root, "skills.sqlite"),
    db = openSkillDatabase(path);
  databases.push(db);
  const registry = new SqliteSkillRegistry(db),
    bundles = new FileSkillBundles(join(root, "bundles")),
    catalog = new SkillCatalog(registry, bundles, "0.0.14", () => 1700000000000);
  return { root, path, db, registry, bundles, catalog };
}
const origin = (value: Awaited<ReturnType<typeof pack>>) => ({
  kind: "upload",
  name: "Writing Kit.zip",
  sha256: value.digest,
});
async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  value: Awaited<ReturnType<typeof pack>>,
  selected = ["writing", "blog-outline", "brand-voice"],
) {
  const source = origin(value),
    review = await f.catalog.review(value, source, selected),
    approval = {
      id: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      selected,
      capabilities: review.capabilities,
    };
  return { installed: await f.catalog.install(value, source, approval, "reviewer:test"), approval, source, review };
}
const authority = {
  outputType: "document" as const,
  available: new Set(SKILL_CAPABILITIES),
  granted: new Set(SKILL_CAPABILITIES),
  entitled: new Set<string>(),
};
function captureInput(value: Awaited<ReturnType<typeof pack>>, ids = ["writing", "blog-outline"]) {
  return {
    id: randomUUID(),
    requestBinding: "a".repeat(64),
    selections: ids.map((id) => ({
      packageId: value.manifest.id,
      version: value.manifest.version,
      digest: value.digest,
      id,
      parameters: id === "blog-outline" ? { audience: "Developers" } : {},
    })),
  };
}
const operation = (f: Awaited<ReturnType<typeof fixture>>, value: Awaited<ReturnType<typeof pack>>) => ({
  operationId: randomUUID(),
  id: value.manifest.id,
  version: value.manifest.version,
  expectedRevision: f.registry.revision(),
});

test("review and selective install bind exact capabilities and source without implicitly enabling other exports", async () => {
  const f = await fixture(),
    value = await pack(),
    source = origin(value),
    review = await f.catalog.review(value, source, ["blog-outline"]);
  expect(review.capabilities).toEqual([]);
  expect(review.manifest.name.en).toBe("Writing kit");
  expect(review.origin).toEqual(source);
  expect(f.registry.list().packages).toEqual([]);
  const { installed } = await install(f, value, ["blog-outline"]);
  expect(installed.exports.filter((item) => item.enabled).map((item) => item.id)).toEqual(["blog-outline"]);
  expect(installed.grants).toEqual([]);
  await expect(
    f.catalog.setExports(
      { ...operation(f, value), exports: installed.exports.map((item) => ({ ...item, enabled: true })) },
      "reviewer:test",
    ),
  ).rejects.toThrow("approvalRequired");
  expect(f.registry.revision()).toBe(1);
  expect((await f.catalog.audit()).length).toBe(1);
});
test("installation retries reuse a stable operation and cannot overwrite a later removal", async () => {
  const f = await fixture(),
    value = await pack(),
    first = await install(f, value);
  expect((await f.catalog.install(value, first.source, first.approval, "reviewer:test")).digest).toBe(value.digest);
  expect(f.registry.revision()).toBe(1);
  await f.catalog.remove(operation(f, value), "reviewer:test");
  expect((await f.catalog.install(value, first.source, first.approval, "reviewer:test")).removed).toBe(true);
  expect(f.registry.revision()).toBe(2);
  await expect(
    f.catalog.install(value, first.source, { ...first.approval, selected: ["writing"] }, "reviewer:test"),
  ).rejects.toThrow("operationConflict");
  await expect(f.catalog.install(value, first.source, first.approval, "another:reviewer")).rejects.toThrow("notFound");
});
test("stale, changed-content, changed-source and unapproved capability reviews never commit", async () => {
  const f = await fixture(),
    value = await pack(),
    review = await f.catalog.review(value, origin(value), ["writing"]);
  const approval = {
    id: randomUUID(),
    expectedRevision: review.revision,
    reviewHash: review.reviewHash,
    selected: ["writing"],
    capabilities: review.capabilities,
  };
  await expect(
    f.catalog.install(value, origin(value), { ...approval, capabilities: [] }, "reviewer:test"),
  ).rejects.toThrow("approvalRequired");
  await expect(
    f.catalog.install(value, { ...origin(value), name: "another.zip" }, approval, "reviewer:test"),
  ).rejects.toThrow("reviewChanged");
  const tampered = await pack((m) => {
    m.description.en = "Changed bytes after approval";
  });
  await expect(f.catalog.install(tampered, origin(value), approval, "reviewer:test")).rejects.toThrow("reviewChanged");
  await install(f, value);
  await expect(f.catalog.install(value, origin(value), approval, "reviewer:test")).rejects.toThrow();
  expect(f.registry.revision()).toBe(1);
  await expect(f.catalog.review(tampered, origin(tampered), ["writing"])).rejects.toThrow("immutableVersion");
});
test("concurrent installers fence revisions while identical operation retries remain idempotent", async () => {
  const f = await fixture(),
    value = await pack(),
    review = await f.catalog.review(value, origin(value), ["writing"]),
    approval = {
      id: randomUUID(),
      expectedRevision: 0,
      reviewHash: review.reviewHash,
      selected: ["writing"],
      capabilities: review.capabilities,
    };
  const same = await Promise.all([
    f.catalog.install(value, origin(value), approval, "reviewer:test"),
    f.catalog.install(value, origin(value), approval, "reviewer:test"),
  ]);
  expect(same[0].digest).toBe(same[1].digest);
  expect((await f.catalog.audit()).length).toBe(1);
  const next = await pack((m) => {
      m.version = "2.0.0";
    }),
    plan = await f.catalog.review(next, origin(next), ["writing"]),
    base = {
      expectedRevision: plan.revision,
      reviewHash: plan.reviewHash,
      selected: ["writing"],
      capabilities: plan.capabilities,
    };
  const contenders = await Promise.allSettled([
    f.catalog.install(next, origin(next), { ...base, id: randomUUID() }, "reviewer:a"),
    f.catalog.install(next, origin(next), { ...base, id: randomUUID() }, "reviewer:b"),
  ]);
  expect(contenders.filter((value) => value.status === "fulfilled").length).toBe(1);
  expect(contenders.filter((value) => value.status === "rejected").length).toBe(1);
  expect(f.registry.revision()).toBe(2);
});
test("actual database reopen and content reread preserve versions, flags, attribution and audit", async () => {
  const f = await fixture(),
    old = await pack(),
    next = await pack((m) => {
      m.version = "2.0.0";
    });
  await install(f, old);
  await install(f, next);
  await f.catalog.activate(operation(f, old), "reviewer:test");
  expect(f.registry.active(old.manifest.id)!.version).toBe("1.0.0");
  const db = openSkillDatabase(f.path);
  databases.push(db);
  const registry = new SqliteSkillRegistry(db),
    bundles = new FileSkillBundles(join(f.root, "bundles")),
    reopened = new SkillCatalog(registry, bundles, "0.0.14");
  expect(await reopened.list()).toEqual(await f.catalog.list());
  expect(await reopened.audit()).toEqual(await f.catalog.audit());
  expect((await bundles.read(old.digest)).readManifest()).toEqual(old.readManifest());
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.root, "bundles", old.digest + ".json"))).mode & 0o777).toBe(0o600);
});
test("accepted captures freeze order and parameters, survive upgrades and uninstall, and bind the owner and request", async () => {
  const f = await fixture(),
    value = await pack();
  await install(f, value);
  const input = captureInput(value),
    captured = await f.catalog.capture(input, "owner:one", authority);
  input.selections[1]!.parameters.audience = "Changed later";
  expect(captured.composition.skills[1]!.parameters.audience).toBe("Developers");
  expect(captured.origins[0]!.origin).toEqual(origin(value));
  const next = await pack((m) => {
    m.version = "2.0.0";
  });
  await install(f, next);
  await f.catalog.remove(operation(f, value), "reviewer:test");
  expect(await f.catalog.getCapture(captured.id, "owner:one")).toEqual(captured);
  const original = {
    ...input,
    selections: input.selections.map((item, index) => ({
      ...item,
      parameters: index === 1 ? { audience: "Developers" } : {},
    })),
  };
  expect(await f.catalog.capture(original, "owner:one", authority)).toEqual(captured);
  await expect(f.catalog.capture(input, "owner:one", authority)).rejects.toThrow("operationConflict");
  await expect(f.catalog.getCapture(captured.id, "owner:two")).rejects.toThrow("notFound");
  await expect(f.catalog.capture({ ...original, id: randomUUID() }, "owner:one", authority)).rejects.toThrow(
    "skillDisabled",
  );
  const db = openSkillDatabase(f.path);
  databases.push(db);
  const reopened = new SkillCatalog(new SqliteSkillRegistry(db), f.bundles, "0.0.14");
  expect(await reopened.getCapture(captured.id, "owner:one")).toEqual(captured);
});
test("disable during bundle IO fences a new capture without losing earlier accepted snapshots", async () => {
  const f = await fixture(),
    value = await pack();
  const { installed } = await install(f, value),
    accepted = await f.catalog.capture(captureInput(value), "owner:one", authority);
  let changed = false;
  const racing: SkillBundleStore = {
    put: (pack) => f.bundles.put(pack),
    async read(digest) {
      const pack = await f.bundles.read(digest);
      if (!changed) {
        changed = true;
        await f.catalog.setExports(
          { ...operation(f, value), exports: installed.exports.map((item) => ({ ...item, enabled: false })) },
          "reviewer:test",
        );
      }
      return pack;
    },
  };
  const service = new SkillCatalog(f.registry, racing, "0.0.14"),
    input = captureInput(value, ["writing"]);
  await expect(service.capture(input, "owner:one", authority)).rejects.toThrow("registryConflict");
  expect(f.registry.captureById("owner:one", input.id)).toBeNull();
  expect(await f.catalog.getCapture(accepted.id, "owner:one")).toEqual(accepted);
  await expect(f.catalog.capture(captureInput(value), "owner:one", authority)).rejects.toThrow("skillDisabled");
});
test("failed registry journaling rolls back all visible metadata while immutable orphan content stays uninstalled", async () => {
  const f = await fixture(),
    value = await pack();
  f.db.exec(
    "CREATE TRIGGER fail_skill_audit BEFORE INSERT ON skill_audit BEGIN SELECT RAISE(FAIL,'audit unavailable'); END",
  );
  await expect(install(f, value)).rejects.toThrow("audit unavailable");
  expect(f.registry.revision()).toBe(0);
  expect((await f.catalog.list()).packages).toEqual([]);
  expect(await f.catalog.audit()).toEqual([]);
  expect(await readdir(join(f.root, "bundles"))).toEqual([value.digest + ".json"]);
  f.db.exec("DROP TRIGGER fail_skill_audit");
  expect((await install(f, value)).installed.active).toBe(true);
});
test("corruption, symbolic links, oversized files and forged content identities cannot be activated", async () => {
  const f = await fixture(),
    value = await pack(),
    { installed } = await install(f, value),
    target = join(f.root, "bundles", value.digest + ".json");
  await expect(f.bundles.put({ ...value, digest: "0".repeat(64) })).rejects.toThrow("unavailable");
  const original = await readFile(target);
  await writeFile(target, "{}");
  await expect(f.catalog.activate(operation(f, value), "reviewer:test")).rejects.toThrow("unavailable");
  expect(f.registry.active(installed.id)!.digest).toBe(installed.digest);
  await rm(target);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, original);
  await symlink(outside, target);
  await expect(f.bundles.read(value.digest)).rejects.toThrow("unavailable");
  await rm(target);
  const sparse = await open(target, "w");
  await sparse.truncate(SKILL_BUNDLE_BYTES + 1);
  await sparse.close();
  await expect(f.bundles.read(value.digest)).rejects.toThrow("unavailable");
  expect(await readFile(outside)).toEqual(original);
});
test("bundle decoding rejects altered raw manifests, noncanonical base64 and unknown envelope fields", async () => {
  const value = await pack(),
    encoded = encodeSkillBundle(value),
    raw = JSON.parse(new TextDecoder().decode(encoded));
  const decoded = await decodeSkillBundle(encoded);
  expect(decoded.digest).toBe(value.digest);
  expect(decoded.readManifest()).toEqual(value.readManifest());
  raw.files[0].data += "\n";
  await expect(decodeSkillBundle(new TextEncoder().encode(JSON.stringify(raw)))).rejects.toThrow();
  raw.files[0].data = Buffer.from(value.read(raw.files[0].path)).toString("base64");
  raw.script = "never";
  await expect(decodeSkillBundle(new TextEncoder().encode(JSON.stringify(raw)))).rejects.toThrow();
});
test("registry cursor pages remain stable across new entries and audit cursors preserve changes", async () => {
  const f = await fixture();
  for (const id of ["example.alpha", "example.beta", "example.gamma"])
    await install(
      f,
      await pack((m) => {
        m.id = id;
      }),
    );
  const first = await f.catalog.list(undefined, 2);
  expect(first.packages.map((row) => row.id)).toEqual(["example.alpha", "example.beta"]);
  await install(
    f,
    await pack((m) => {
      m.id = "example.aaa";
    }),
  );
  const second = await f.catalog.list(first.nextCursor!, 2);
  expect(second.packages.map((row) => row.id)).toEqual(["example.gamma"]);
  expect(second.nextCursor).toBeNull();
  expect((await f.catalog.audit(2)).map((row) => row.revision)).toEqual([3, 4]);
  await expect(f.catalog.list("invalid-cursor")).rejects.toThrow("invalidInput");
});
test("schema initialization is repeatable and future schemas are preserved", async () => {
  const f = await fixture();
  const db = openSkillDatabase(f.path);
  databases.push(db);
  expect(new SqliteSkillRegistry(db).revision()).toBe(0);
  f.db.exec("PRAGMA user_version=9");
  expect(() => openSkillDatabase(f.path)).toThrow("unsupportedSchema");
  expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(9);
});
test("builtin writing initializes once and removal survives restarts without reinstalling", async () => {
  const f = await fixture();
  await Promise.all([seedBuiltinWriting(f.registry, f.catalog), seedBuiltinWriting(f.registry, f.catalog)]);
  const builtin = await builtinWritingPack(),
    installed = f.registry.get(builtin.manifest.id, builtin.manifest.version)!;
  expect(f.registry.revision()).toBe(2);
  expect(installed.origin).toEqual({ kind: "builtin", id: builtin.manifest.id });
  expect(installed.exports).toEqual([{ id: "writing", enabled: true }]);
  expect(builtin.text("LICENSE")).toContain("FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT");
  await f.catalog.remove(operation(f, builtin), "reviewer:test");
  await seedBuiltinWriting(f.registry, f.catalog);
  expect(f.registry.get(builtin.manifest.id, builtin.manifest.version)!.removed).toBe(true);
  expect(f.registry.revision()).toBe(3);
  const db = openSkillDatabase(f.path);
  databases.push(db);
  const registry = new SqliteSkillRegistry(db),
    catalog = new SkillCatalog(registry, f.bundles, "0.0.14");
  await seedBuiltinWriting(registry, catalog);
  expect(registry.revision()).toBe(3);
});

test("available registry pages filter historical, removed and disabled packages before pagination", async () => {
  const f = await fixture();
  for (const id of ["example.alpha", "example.beta", "example.gamma", "example.removed", "example.disabled"]) {
    for (let n = 0; n < 4; n++)
      await install(
        f,
        await pack((m) => {
          m.id = id;
          m.version = `1.0.${n}`;
        }),
      );
  }
  const removed = await pack((m) => {
    m.id = "example.removed";
    m.version = "1.0.3";
  });
  await f.catalog.remove(operation(f, removed), "reviewer:test");
  const disabled = await pack((m) => {
    m.id = "example.disabled";
    m.version = "1.0.3";
  });
  const current = f.registry.active(disabled.manifest.id)!;
  await f.catalog.setExports(
    { ...operation(f, disabled), exports: current.exports.map((e) => ({ ...e, enabled: false })) },
    "reviewer:test",
  );
  const first = await f.catalog.list(undefined, 2, true);
  expect(first.packages.map((p) => [p.id, p.version])).toEqual([
    ["example.alpha", "1.0.3"],
    ["example.beta", "1.0.3"],
  ]);
  const second = await f.catalog.list(first.nextCursor!, 2, true);
  expect(second.packages.map((p) => p.id)).toEqual(["example.gamma"]);
  expect(second.nextCursor).toBeNull();
  expect((await f.catalog.list(undefined, 100)).packages).toHaveLength(20);
  expect((await f.catalog.detail("example.alpha", "1.0.0")).package?.active).toBe(false);
  await expect(f.catalog.list("invalid-cursor", 2, true)).rejects.toThrow("invalidInput");
});
