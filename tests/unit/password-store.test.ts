import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStoredPassword } from "../../src/server/auth/security.js";
import { loadStoredPassword, passwordStorePath, saveStoredPassword } from "../../src/server/auth/password-store.js";

describe("managed LAN password store", () => {
  test("resolves the configured location", () => {
    expect(passwordStorePath({ PANDA_FORCE_AUTH_STORE: "./custom-auth.json" })).toBe(
      join(process.cwd(), "custom-auth.json"),
    );
    expect(passwordStorePath({ CODEX_HOME: "/tmp/codex-home", PANDA_FORCE_HOME: "/tmp/product-state" })).toBe(
      "/tmp/product-state/config/password.json",
    );
  });

  test("writes only the credential hash with private permissions and never overwrites", () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-password-store-"));
    const path = join(root, "nested", "auth.json");
    const password = "correct horse battery staple";
    const credential = createStoredPassword(password, { salt: "0123456789abcdef" });
    try {
      saveStoredPassword(path, credential);
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain(password);
      expect(loadStoredPassword(path)).toEqual(credential);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => saveStoredPassword(path, credential)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("upgrades retain the legacy product password while explicit and canonical stores take precedence", () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-legacy-product-password-")),
      env = { PANDA_FORCE_HOME: root, CODEX_HOME: join(root, "model-home") },
      legacy = join(root, ".webui", "legacy-password.json"),
      canonical = join(root, "config", "password.json"),
      credential = createStoredPassword("existing legacy product password");
    try {
      saveStoredPassword(legacy, credential);
      const original = readFileSync(legacy, "utf8");
      expect(passwordStorePath(env)).toBe(legacy);
      expect(loadStoredPassword(passwordStorePath(env))).toEqual(credential);
      saveStoredPassword(canonical, createStoredPassword("new canonical password"));
      expect(passwordStorePath(env)).toBe(canonical);
      expect(readFileSync(legacy, "utf8")).toBe(original);
      const explicit = join(root, "explicit.json");
      expect(passwordStorePath({ ...env, PANDA_FORCE_AUTH_STORE: explicit })).toBe(explicit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed credential files", () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-password-store-invalid-"));
    const path = join(root, "auth.json");
    try {
      writeFileSync(path, '{"version":1,"algorithm":"scrypt"}\n');
      expect(() => loadStoredPassword(path)).toThrow("Invalid PandaForce password store");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
