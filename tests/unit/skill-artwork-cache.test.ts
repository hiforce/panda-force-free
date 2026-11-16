import { expect, test } from "bun:test";
import { SkillArtworkCache } from "../../src/server/skills/catalog/artwork-cache.js";
import { SkillInspection } from "../../src/server/skills/catalog/inspection.js";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import type { SkillRegistryStore } from "../../src/server/skills/ports.js";
import type { SkillPackManifest } from "../../src/shared/skills/contracts.js";
import type { InstalledSkillPack } from "../../src/shared/skills/registry.js";

test("cover sources coalesce concurrent loads, detach returned bytes and retry failed loads", async () => {
  const cache = new SkillArtworkCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await Promise.resolve();
    return new Uint8Array([1, 2, 3]);
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => cache.read("cover", load)));
  expect(calls).toBe(1);
  results[0]!.fill(0);
  expect(await cache.read("cover", load)).toEqual(new Uint8Array([1, 2, 3]));
  expect(results[1]).toEqual(new Uint8Array([1, 2, 3]));
  await expect(
    cache.read("retry", () => {
      throw Error("temporary read failure");
    }),
  ).rejects.toThrow();
  expect(await cache.read("retry", load)).toEqual(new Uint8Array([1, 2, 3]));
  await expect(cache.read("oversize", async () => new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow("unavailable");
});

test("cover cache evicts old entries and applies byte and in-flight limits", async () => {
  const cache = new SkillArtworkCache();
  let calls = 0;
  const load = async () => {
    calls++;
    return new Uint8Array([1]);
  };
  for (let i = 0; i < 33; i++) await cache.read(String(i), load);
  await cache.read("1", load);
  expect(calls).toBe(33);
  await cache.read("0", load);
  expect(calls).toBe(34);
  let largeReads = 0;
  const large = async () => {
    largeReads++;
    return new Uint8Array(4 * 1024 * 1024);
  };
  for (const key of ["large-a", "large-b", "large-c"]) await cache.read(key, large);
  await cache.read("large-b", large);
  expect(largeReads).toBe(3);
  await cache.read("large-a", large);
  expect(largeReads).toBe(4);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: 16 }, (_, i) =>
    cache.read("pending-" + i, async () => {
      await gate;
      return new Uint8Array([1]);
    }),
  );
  await expect(cache.read("one-too-many", load)).rejects.toThrow("unavailable");
  release();
  await Promise.all(pending);
});

test("different cover sources share a two-reader concurrency limit", async () => {
  const cache = new SkillArtworkCache();
  let active = 0,
    peak = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = Array.from({ length: 8 }, (_, index) =>
    cache.read("cover-" + index, async () => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return new Uint8Array([index]);
    }),
  );
  await Bun.sleep(1);
  expect(active).toBe(2);
  release();
  await Promise.all(reads);
  expect(peak).toBe(2);
});

test("warm cover reads still check installed identity and digest before using verified cached source bytes", async () => {
  const base = (await nativeSkillPackage()).pack,
    manifest = JSON.parse(JSON.stringify(base.manifest)) as SkillPackManifest,
    bytes = new Uint8Array([1, 2, 3]);
  manifest.files.push("artwork/cover.webp");
  manifest.skills[0]!.cover = { path: "artwork/cover.webp", alt: { en: "Test cover" } };
  const pack = await verifySkillResources(new TextEncoder().encode(JSON.stringify(manifest)), [
    ...base.resources.map((resource) => ({ path: resource.path, bytes: base.read(resource.path) })),
    { path: "artwork/cover.webp", bytes },
  ]);
  let reads = 0,
    checks = 0,
    present = true;
  const installed: InstalledSkillPack = {
    id: manifest.id,
    version: manifest.version,
    digest: pack.digest,
    manifest: pack.manifest,
    origin: { kind: "builtin", id: manifest.id },
    installedAt: 1,
    installedBy: "test",
    removed: false,
    active: true,
    exports: [],
    grants: [],
  };
  const registry = {
    async detail() {
      checks++;
      return { revision: 1, package: present ? installed : null };
    },
  } as unknown as SkillRegistryStore;
  const inspection = new SkillInspection(registry, {
    async put() {},
    async read() {
      reads++;
      return pack;
    },
  });
  const request = () => inspection.artwork(manifest.id, manifest.version, pack.digest, manifest.skills[0]!.id);
  const covers = await Promise.all(Array.from({ length: 8 }, request));
  expect(reads).toBe(1);
  expect(checks).toBe(8);
  covers[0]!.fill(0);
  expect(await request()).toEqual(bytes);
  expect(reads).toBe(1);
  await expect(
    inspection.artwork(manifest.id, manifest.version, "f".repeat(64), manifest.skills[0]!.id),
  ).rejects.toThrow("immutableVersion");
  await expect(inspection.artwork(manifest.id, manifest.version, pack.digest, "missing")).rejects.toThrow("notFound");
  present = false;
  await expect(request()).rejects.toThrow("notInstalled");
  expect(reads).toBe(1);
});
