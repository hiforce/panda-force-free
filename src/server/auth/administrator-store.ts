import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../../shared/records.js";
import { localAuthPaths } from "./paths.js";
import { errorCode } from "./../../shared/errors.js";
import type { StoredPassword } from "./password-store.js";
import { createStoredPassword, isStoredPassword } from "./security.js";

export type StoredAdministrator = {
  version: 1;
  username: string;
  role: "admin";
  ownerId?: string;
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
  return localAuthPaths(env).administrator;
}

export function isStoredAdministrator(value: unknown): value is StoredAdministrator {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.role === "admin" &&
    (value.ownerId === undefined || (typeof value.ownerId === "string" && /^[a-f0-9]{64}$/.test(value.ownerId))) &&
    validAdministratorUsername(value.username) &&
    value.username === normalizeAdministratorUsername(value.username) &&
    Number.isSafeInteger(value.createdAt) &&
    typeof value.createdAt === "number" &&
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
  if (!isStoredAdministrator(administrator)) throw new Error("Invalid administrator account");
  return administrator;
}

export function loadStoredAdministrator(path: string): StoredAdministrator | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw);
  if (!isStoredAdministrator(record)) throw new Error(`Invalid PandaForce administrator store: ${path}`);
  return record;
}

export function saveStoredAdministrator(path: string, record: StoredAdministrator) {
  if (!isStoredAdministrator(record)) throw new Error("Invalid administrator account");
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
