import { pandaEnvironment, existingApplicationPath } from "../environment.js";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createStoredPassword, isStoredPassword } from "./security.js";
import type { StoredPassword } from "./password-store.js";

export type StoredAdministrator = {
  version: 1;
  username: string;
  role: "admin";
  createdAt: number;
  password: StoredPassword;
};

export function normalizeAdministratorUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validAdministratorUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._@-]{2,63}$/i.test(value);
}

export function administratorStorePath(env: NodeJS.ProcessEnv = process.env) {
  env = pandaEnvironment(env);
  if (env.PANDA_FORCE_ADMIN_STORE) return resolve(env.PANDA_FORCE_ADMIN_STORE);
  if (env.PANDA_FORCE_AUTH_STORE) return `${resolve(env.PANDA_FORCE_AUTH_STORE)}.administrator.json`;
  return existingApplicationPath(join(env.CODEX_HOME || join(homedir(), ".codex"), "panda-force-admin.json"));
}

function validRecord(value: any): value is StoredAdministrator {
  return (
    value?.version === 1 &&
    value.role === "admin" &&
    validAdministratorUsername(value.username) &&
    value.username === normalizeAdministratorUsername(value.username) &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt > 0 &&
    isStoredPassword(value.password)
  );
}

export function createStoredAdministrator(username: string, password: string | StoredPassword): StoredAdministrator {
  const administrator: StoredAdministrator = {
    version: 1,
    username: normalizeAdministratorUsername(username),
    role: "admin",
    createdAt: Date.now(),
    password: typeof password === "string" ? (createStoredPassword(password) as StoredPassword) : password,
  };
  if (!validRecord(administrator)) throw new Error("Invalid administrator account");
  return administrator;
}

export function loadStoredAdministrator(path: string): StoredAdministrator | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw);
  if (!validRecord(record)) throw new Error(`Invalid PandaForce administrator store: ${path}`);
  return record;
}

export function saveStoredAdministrator(path: string, record: StoredAdministrator) {
  if (!validRecord(record)) throw new Error("Invalid administrator account");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // Publish a complete file atomically and exclusively. Another process can
    // neither read a partial credential nor overwrite the first administrator.
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
