import { expect, test } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionRevocations } from "../../src/server/auth/session-revocations.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";
test("logout revocations are lazy, close every session connection and survive owner restart", () => {
  const directory = createTemporaryDirectory("panda-session-test-", { preferMemory: true });
  const path = join(directory, "sessions.sqlite");
  let now = 1000,
    closed = 0;
  const token = "2000.random.signature";
  let sessions = createSessionRevocations(path, () => now);
  try {
    expect(sessions.has(token)).toBe(false);
    expect(existsSync(path)).toBe(false);
    sessions.watch(token, () => {
      closed++;
    });
    sessions.watch(token, () => {
      throw new Error("socket already closed");
    });
    sessions.watch(token, () => {
      closed++;
    });
    sessions.revoke(token);
    expect(closed).toBe(2);
    sessions.close();
    sessions = createSessionRevocations(path, () => now);
    expect(sessions.has(token)).toBe(true);
    sessions.watch(token, () => {
      closed++;
    });
    expect(closed).toBe(3);
    now = 2001;
    expect(sessions.has(token)).toBe(false);
  } finally {
    sessions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy logout records migrate read-only and still reject cookies after the old location disappears", () => {
  const directory = createTemporaryDirectory("panda-session-migrate-", { preferMemory: true });
  const source = join(directory, "legacy.sqlite"),
    target = join(directory, "product", "sessions.sqlite");
  const token = "9000.random.signature",
    expired = "1500.expired.signature";
  const old = createSessionRevocations(source, () => 1000);
  old.revoke(token);
  old.revoke(expired);
  old.close();
  const unchanged = readFileSync(source);
  let current = createSessionRevocations(target, () => 2000, source);
  try {
    expect(current.has(token)).toBe(true);
    expect(current.has(expired)).toBe(false);
    expect(readFileSync(source)).toEqual(unchanged);
    current.close();
    rmSync(source);
    current = createSessionRevocations(target, () => 2000, source);
    expect(current.has(token)).toBe(true);
    current.close();
    current = createSessionRevocations(target, () => 2000, target);
    expect(current.has(token)).toBe(true);
  } finally {
    current.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
