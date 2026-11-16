import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  administratorStorePath,
  createStoredAdministrator,
  loadStoredAdministrator,
  saveStoredAdministrator,
} from "../../src/server/auth/administrator-store.js";
import { createStoredPassword, verifyStoredPassword } from "../../src/server/auth/security.js";

test("administrator records normalize identity, retain private hashes and cannot overwrite the first owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "administrator-store-")),
    path = join(dir, "private", "admin.json"),
    password = "test-only administrator password";
  try {
    const record = createStoredAdministrator("  OWNER.Name  ", password);
    saveStoredAdministrator(path, record);
    expect(loadStoredAdministrator(path)?.username).toBe("owner.name");
    expect(verifyStoredPassword(password, loadStoredAdministrator(path)!.password)).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain(password);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => saveStoredAdministrator(path, createStoredAdministrator("other-owner", password))).toThrow();
    expect(loadStoredAdministrator(path)).toEqual(record);
    expect(() => createStoredAdministrator("<script>", password)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy migration preserves the existing credential and corrupt admin files fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "administrator-migration-")),
    path = join(dir, "admin.json");
  try {
    const password = createStoredPassword("legacy test password");
    const record = createStoredAdministrator("admin", password);
    expect(record.password).toEqual(password);
    saveStoredAdministrator(path, record);
    expect(loadStoredAdministrator(path)).toEqual(record);
    writeFileSync(path, JSON.stringify({ ...record, role: "guest" }));
    expect(() => loadStoredAdministrator(path)).toThrow("Invalid PandaForce administrator store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("administrator paths keep custom and test state isolated", () => {
  expect(administratorStorePath({ CODEX_HOME: "/tmp/isolated", PANDA_FORCE_HOME: "/tmp/product-state" })).toBe(
    "/tmp/product-state/config/administrator.json",
  );
  expect(administratorStorePath({ PANDA_FORCE_AUTH_STORE: "/tmp/legacy.json" })).toBe(
    "/tmp/legacy.json.administrator.json",
  );
  expect(administratorStorePath({ PANDA_FORCE_ADMIN_STORE: "/tmp/administrator.json" })).toBe(
    "/tmp/administrator.json",
  );
});
test("upgrades reuse the product's legacy administrator without replacing it or the canonical owner", () => {
  const root = mkdtempSync(join(tmpdir(), "administrator-legacy-product-")),
    legacy = join(root, ".webui", "administrator.json"),
    canonical = join(root, "config", "administrator.json"),
    env = { PANDA_FORCE_HOME: root, CODEX_HOME: join(root, "model-home") },
    password = "legacy product owner password";
  try {
    saveStoredAdministrator(legacy, createStoredAdministrator("existing-owner", password));
    const original = readFileSync(legacy, "utf8");
    expect(administratorStorePath(env)).toBe(legacy);
    expect(verifyStoredPassword(password, loadStoredAdministrator(administratorStorePath(env))!.password)).toBe(true);
    expect(readFileSync(legacy, "utf8")).toBe(original);
    saveStoredAdministrator(canonical, createStoredAdministrator("canonical-owner", "canonical owner password"));
    expect(loadStoredAdministrator(administratorStorePath(env))!.username).toBe("canonical-owner");
    expect(readFileSync(legacy, "utf8")).toBe(original);
    const explicit = join(root, "explicit.json");
    expect(administratorStorePath({ ...env, PANDA_FORCE_ADMIN_STORE: explicit })).toBe(explicit);
    mkdirSync(join(root, "other-product"));
    expect(administratorStorePath({ ...env, PANDA_FORCE_HOME: join(root, "other-product") })).not.toBe(legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
