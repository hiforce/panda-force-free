import { expect, test } from "bun:test";
import { pandaEnvironment } from "../../src/server/environment.js";
import { resolveAppServerConnection } from "../../src/server/bridge/app-server-connection.js";
import { readOssAttachmentConfig } from "../../src/server/workspace/oss-attachments.js";
import { passwordStorePath } from "../../src/server/auth/password-store.ts";
import { administratorStorePath } from "../../src/server/auth/administrator-store.ts";
import { localAuthPaths } from "../../src/server/auth/paths.js";
test("legacy environment aliases remain read-only compatible; explicit PandaForce values win", () => {
  const source = {
    CODEX_WEBUI_CWD: "/legacy",
    CODEX_WEBUI_PASSWORD: "legacy",
    PANDA_FORCE_PASSWORD: "",
    PANDA_FORCE_CWD: "/current",
    CODEX_HOME: "/engine",
  };
  const result = pandaEnvironment(source);
  expect(result.PANDA_FORCE_CWD).toBe("/current");
  expect(result.PANDA_FORCE_PASSWORD).toBe("");
  expect(result.CODEX_HOME).toBe("/engine");
  expect(source).not.toHaveProperty("PANDA_FORCE_AUTH_MODE");
  expect(pandaEnvironment({ CODEX_WEBUI_CWD: "/legacy" }).PANDA_FORCE_CWD).toBe("/legacy");
});
test("standalone configuration readers consistently accept legacy aliases and canonical overrides", () => {
  expect(
    resolveAppServerConnection(
      { CODEX_WEBUI_APP_SERVER_MODE: "shared", PANDA_FORCE_APP_SERVER_MODE: "isolated" },
      "/tmp",
    ),
  ).toEqual({ mode: "isolated" });
  expect(readOssAttachmentConfig({ CODEX_WEBUI_ATTACHMENT_STORAGE: "local" })).toBeNull();
  expect(passwordStorePath({ CODEX_WEBUI_AUTH_STORE: "/tmp/previous-auth" })).toBe("/tmp/previous-auth");
  expect(
    administratorStorePath({
      CODEX_WEBUI_ADMIN_STORE: "/tmp/previous-admin",
      PANDA_FORCE_ADMIN_STORE: "/tmp/current-admin",
    }),
  ).toBe("/tmp/current-admin");
});

test("existing application files are reused without moving or replacing them", async () => {
  const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { existingApplicationPath } = await import("../../src/server/environment.js");
  const root = mkdtempSync(join(tmpdir(), "panda-state-compat-"));
  try {
    const old = join(root, "codex-webui-admin.json"),
      current = join(root, "panda-force-admin.json");
    writeFileSync(old, "existing");
    expect(existingApplicationPath(current)).toBe(old);
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(old, "utf8")).toBe("existing");
    writeFileSync(current, "canonical");
    expect(existingApplicationPath(current)).toBe(current);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new authentication state belongs to the product volume while explicit and existing legacy files retain priority", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "panda-auth-paths-")),
    product = join(root, "product"),
    model = join(root, "model");
  const env = { PANDA_FORCE_HOME: product, CODEX_HOME: model };
  try {
    mkdirSync(model);
    const paths = localAuthPaths(env);
    expect(paths.password).toBe(join(product, "config", "password.json"));
    expect(paths.administrator).toBe(join(product, "config", "administrator.json"));
    expect(paths.revocations).toBe(join(product, "data", "auth-sessions.sqlite"));
    writeFileSync(join(model, "panda-force-admin.json"), "existing administrator");
    writeFileSync(join(model, "codex-webui-auth.json"), "existing password");
    expect(localAuthPaths(env).administrator).toBe(join(model, "panda-force-admin.json"));
    expect(localAuthPaths(env).password).toBe(join(model, "codex-webui-auth.json"));
    mkdirSync(join(product, "config"), { recursive: true });
    writeFileSync(paths.administrator, "product administrator");
    expect(localAuthPaths(env).administrator).toBe(paths.administrator);
    expect(readFileSync(join(model, "panda-force-admin.json"), "utf8")).toBe("existing administrator");
    expect(localAuthPaths({ ...env, PANDA_FORCE_SESSION_STORE: join(root, "session.sqlite") }).revocations).toBe(
      join(root, "session.sqlite"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
