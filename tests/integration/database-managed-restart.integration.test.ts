import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const supervisor = new URL("../../src/server/logging/managed-restart.ts", import.meta.url).pathname;

test("database handoff restarts once while ordinary failures exit without a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-managed-restart-"));
  try {
    const counter = join(root, "count"),
      worker = join(root, "worker.ts");
    await writeFile(
      worker,
      `import {existsSync,readFileSync,writeFileSync} from "node:fs";const path=${JSON.stringify(counter)};const count=existsSync(path)?Number(readFileSync(path,"utf8")):0;writeFileSync(path,String(count+1));if(process.env.PANDA_FORCE_MANAGED_RESTART!=="1")throw Error("Missing handoff contract");process.exit(count===0?75:9);`,
    );
    const entry = `import {runRestartableLoggedProcess} from ${JSON.stringify(supervisor)};process.exitCode=await runRestartableLoggedProcess({command:[process.execPath,${JSON.stringify(worker)}],cwd:${JSON.stringify(root)},logging:{enabled:false,directory:${JSON.stringify(root)},maxFileBytes:1024,maxFiles:1}});`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(9);
    expect(await readFile(counter, "utf8")).toBe("2");
    expect(stdout.match(/Service starting/g)).toHaveLength(2);
    expect(stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGTERM prevents a handoff restart even when a child exits with the reserved code", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-managed-stop-"));
  try {
    const worker = join(root, "worker.ts");
    await writeFile(
      worker,
      'process.on("SIGTERM",()=>process.exit(75));console.log("ready");setInterval(()=>{},1000);',
    );
    const entry = `import {runRestartableLoggedProcess} from ${JSON.stringify(supervisor)};process.exitCode=await runRestartableLoggedProcess({command:[process.execPath,${JSON.stringify(worker)}],cwd:${JSON.stringify(root)},logging:{enabled:false,directory:${JSON.stringify(root)},maxFileBytes:1024,maxFiles:1}});`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdout: "pipe", stderr: "pipe" }),
      reader = child.stdout.getReader();
    let stdout = "";
    while (!stdout.includes("ready")) {
      const part = await reader.read();
      if (part.done) throw Error("Missing readiness");
      stdout += new TextDecoder().decode(part.value);
    }
    child.kill("SIGTERM");
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      stdout += new TextDecoder().decode(part.value);
    }
    expect(await child.exited).toBe(143);
    expect(stdout.match(/Service starting/g)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
