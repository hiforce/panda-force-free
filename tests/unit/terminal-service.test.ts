import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createTerminalSession,
  normalizeTerminalResize,
  resolveTerminalCwd,
} from "../../src/server/terminal/session.js";
import { terminalEnvironment } from "../../src/server/terminal/protocol.js";

describe("terminal service", () => {
  test("keeps shell basics while excluding service credentials, loader injection and forwarded agents", () => {
    const environment = terminalEnvironment({
      HOME: "/safe/home",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "secret",
      NODE_OPTIONS: "--require malicious.js",
      LD_PRELOAD: "/tmp/library.so",
      BASH_ENV: "/tmp/shell.sh",
      SSH_AUTH_SOCK: "/tmp/agent",
      UNRECOGNIZED_FUTURE_SECRET: "secret",
    });
    expect(environment.HOME).toBe("/safe/home");
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(environment.TERM).toBe("xterm-256color");
    expect(JSON.stringify(environment)).not.toMatch(/secret|malicious|library|shell\.sh|agent/);
  });
  test("accepts bounded PTY sizes and rejects malformed resize messages", () => {
    expect(normalizeTerminalResize({ type: "resize", cols: 120, rows: 32 })).toEqual({ cols: 120, rows: 32 });
    expect(normalizeTerminalResize({ type: "resize", cols: 0, rows: 32 })).toBeNull();
    expect(normalizeTerminalResize({ type: "resize", cols: 120, rows: 5000 })).toBeNull();
    expect(normalizeTerminalResize({ type: "data", cols: 120, rows: 32 })).toBeNull();
  });

  test("keeps terminal cwd inside the same allowed browse roots", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "panda-force-test-root-")));
    const project = realpathSync(mkdtempSync(join(root, "project-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "panda-force-test-outside-")));
    const roots = [root];
    expect(resolveTerminalCwd(project, roots, root)).toBe(project);
    expect(resolveTerminalCwd(outside, roots, root)).toBe(root);
    expect(resolveTerminalCwd(null, roots, root)).toBe(root);
  });

  test("reports a missing PTY worker runtime without crashing the server", async () => {
    const previous = process.env.PANDA_FORCE_NODE;
    process.env.PANDA_FORCE_NODE = "/definitely/missing/panda-force-node";
    try {
      const result = await new Promise((resolve) => {
        const session = createTerminalSession({
          cwd: tmpdir(),
          onData: () => {},
          onExit: (event) => {
            session.kill();
            resolve(event);
          },
        });
      });
      expect(result.exitCode).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.PANDA_FORCE_NODE;
      else process.env.PANDA_FORCE_NODE = previous;
    }
  });
});
