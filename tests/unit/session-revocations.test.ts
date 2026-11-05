import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
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
