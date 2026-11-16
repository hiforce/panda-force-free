import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localAuthPaths } from "./paths.js";
import { errorCode } from "./../../shared/errors.js";
import { isStoredPassword } from "./security.js";

export type StoredPassword = {
  version: 1;
  algorithm: "scrypt";
  salt: string;
  hash: string;
};

export function passwordStorePath(env: NodeJS.ProcessEnv = process.env) {
  return localAuthPaths(env).password;
}

export function loadStoredPassword(path: string): StoredPassword | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const credential = JSON.parse(raw);
  if (!isStoredPassword(credential)) throw new Error(`Invalid PandaForce password store: ${path}`);
  return credential;
}

export function saveStoredPassword(path: string, credential: StoredPassword) {
  if (!isStoredPassword(credential)) throw new Error("Invalid stored password credential");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
