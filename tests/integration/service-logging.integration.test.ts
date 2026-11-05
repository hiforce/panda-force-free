import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localAuthFixture } from "../support/local-auth-fixture.mjs";

const supervisor = new URL("../../src/server/logging/supervisor.js", import.meta.url).pathname;
function content(dir) {
  return readdirSync(dir)
    .filter((n) => /^panda-force-.*\.log$/.test(n))
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .join("\n");
}

test("the launcher preserves stdout/stderr, captures fatal errors and retains a bounded log set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panda-logging-process-"));
  try {
    const worker = join(dir, "worker.mjs");
    writeFileSync(
      worker,
      'process.stdout.write("stdout-marker\\n");process.stderr.write("stderr-marker\\n");for(let i=0;i<100;i++)console.log("日志😀".repeat(100));throw new Error("fatal-marker");',
    );
    const script = `import {runLoggedProcess} from ${JSON.stringify(supervisor)};process.exitCode=await runLoggedProcess({command:[process.execPath,${JSON.stringify(worker)}],logging:{enabled:true,directory:${JSON.stringify(dir)},maxFileBytes:2048,maxFiles:3}});`;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("stdout-marker");
    expect(stdout).toContain("日志😀");
    expect(stderr).toContain("stderr-marker");
    expect(stderr).toContain("fatal-marker");
    const logs = readdirSync(dir).filter((n) => /^panda-force-.*\.log$/.test(n));
    expect(logs.length).toBeLessThanOrEqual(3);
    expect(logs.every((n) => statSync(join(dir, n)).size <= 2048)).toBe(true);
    expect(content(dir)).toContain("fatal-marker");
    expect(content(dir)).toContain("Service exited with code 1");
    expect(content(dir)).not.toContain("�");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("standard app startup logs to disk and forwards SIGTERM without resetting its administrator", async () => {
  const fixture = await localAuthFixture();
  try {
    const installed = await fixture.post("/api/auth/setup", { username: "owner", password: "Abc123" });
    expect(installed.status).toBe(200);
    const configFile = join(fixture.dir, ".panda-force/config/panda-force.json"),
      dir = join(fixture.dir, ".panda-force/logs");
    expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
      logging: { maxFileBytes: 10485760, maxFiles: 10 },
    });
    await fixture.stop();
    const files = content(dir);
    expect(files).toContain("PandaForce listening");
    expect(files).toContain("Received SIGTERM");
    expect(files).toContain("Service exited with code 0");
    expect(files).toMatch(/\d{4}-\d\d-\d\dT.* \[stdout\]/);
    await fixture.start();
    expect((await (await fetch(fixture.base + "/api/auth/status")).json()).setupRequired).toBe(false);
    expect((await fixture.post("/api/auth/login", { username: "owner", password: "Abc123" })).status).toBe(200);
  } finally {
    await fixture.dispose();
  }
}, 20000);

test("overlapping process output shares a bounded retention budget during deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panda-concurrent-log-"));
  try {
    const script = `import {runLoggedProcess} from ${JSON.stringify(supervisor)};process.exitCode=await runLoggedProcess({command:[process.execPath,"--eval",'for(let i=0;i<500;i++)console.log("concurrent-marker-"+i+"日志😀".repeat(100))'],logging:{enabled:true,directory:${JSON.stringify(dir)},maxFileBytes:2048,maxFiles:3}});`;
    const outputs = await Promise.all(
      [0, 1].map(async () => {
        const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
        return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      }),
    );
    for (const [stdout, stderr, code] of outputs) {
      expect(code).toBe(0);
      expect(stdout).toContain("concurrent-marker-499");
      expect(stderr).toBe("");
    }
    const logs = readdirSync(dir).filter((n) => /^panda-force-.*\.log$/.test(n));
    expect(logs.length).toBeLessThanOrEqual(3);
    expect(logs.every((n) => statSync(join(dir, n)).size <= 2048)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("the bundled launcher starts the real backend with persistent logs", async () => {
  const build = Bun.spawnSync([process.execPath, "run", "build:server"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(build.exitCode).toBe(0);
  const fixture = await localAuthFixture({ command: [process.execPath, "dist/start.js"] });
  try {
    expect((await (await fetch(fixture.base + "/api/auth/status")).json()).setupRequired).toBe(true);
    await fixture.stop();
    expect(content(join(fixture.dir, ".panda-force/logs"))).toContain("PandaForce listening");
    expect(content(join(fixture.dir, ".panda-force/logs"))).toContain("Service exited with code 0");
  } finally {
    await fixture.dispose();
  }
}, 20000);
