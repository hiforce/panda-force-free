import { expect, test } from "bun:test";

test("the distributable terminal worker launches a real shell without source-module paths", async () => {
  const build = Bun.spawnSync([process.execPath, "run", "build:server"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(build.exitCode).toBe(0);
  const child = Bun.spawn(["node", new URL("../../dist/worker.js", import.meta.url).pathname, "/tmp", "100", "24"], {
    env: { ...process.env, SHELL: "/bin/bash" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    child.stdin.write("printf 'BUNDLE_'; printf 'TERMINAL_OK\\n'; exit\n");
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(output).toMatch(/(?:^|[\r\n])BUNDLE_TERMINAL_OK\r?\n/);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 15000);
