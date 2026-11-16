import { expect, test } from "bun:test";
import { CreativeTextWorkers } from "../../src/server/creative/assets/projection.js";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const large = () =>
  Buffer.from("<html><body>" + "<p>Current requirements for durable storage.</p>".repeat(20000) + "</body></html>");
test("preview cache identity includes exact resource bytes and captures mutable inputs before worker IO", async () => {
  const pool = new CreativeTextWorkers(1),
    html = Buffer.from('<link rel="stylesheet" href="styles.css"><h1>Original</h1>'),
    resources = [{ name: "styles.css", bytes: Buffer.from("h1{color:navy}") }];
  try {
    const pending = pool.extract("web", "index.html", html, undefined, true, resources);
    resources[0]!.bytes.fill(0);
    expect((await pending).previewHtml).toContain("color:navy");
    const same = pool.extract("web", "index.html", html, undefined, true, [
      { name: "styles.css", bytes: Buffer.from("h1{color:navy}") },
    ]);
    expect(pool.running).toBe(0);
    expect((await same).previewHtml).toContain("color:navy");
    const changed = pool.extract("web", "index.html", html, undefined, true, [
      { name: "styles.css", bytes: Buffer.from("h1{color:green}") },
    ]);
    expect(pool.running).toBe(1);
    expect((await changed).previewHtml).toContain("color:green");
  } finally {
    await pool.close();
  }
});
test("repeated exact parser inputs reuse bounded text output without spawning workers or caching authority", async () => {
  const pool = new CreativeTextWorkers(1),
    bytes = Buffer.from("<h1>Reusable exact original</h1>");
  try {
    const first = await pool.extract("web", "index.html", bytes);
    first.sections[0]!.start = 100000;
    const cached = pool.extract("web", "index.html", bytes);
    expect(pool.running).toBe(0);
    expect((await cached).sections[0]!.start).toBe(0);
    const preview = pool.extract("web", "index.html", bytes, undefined, true);
    expect(pool.running).toBe(1);
    expect((await preview).previewHtml).toContain("Reusable exact original");
    const changed = pool.extract("web", "index.html", Buffer.from("<h1>Changed original</h1>"));
    expect(pool.running).toBe(1);
    expect((await changed).text).toBe("Changed original");
  } finally {
    await pool.close();
  }
  await expect(pool.extract("web", "index.html", bytes)).rejects.toMatchObject({ code: "unavailable" });
});
test("real text workers yield the main event loop and keep cancelled admission until exit", async () => {
  const pool = new CreativeTextWorkers(2),
    controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const first = pool.extract("web", "index.html", large()),
      second = pool.extract("web", "other.html", large(), controller.signal);
    expect(pool.running).toBe(2);
    await expect(pool.extract("web", "extra.html", Buffer.from("<p>Denied</p>"))).rejects.toMatchObject({
      code: "busy",
      status: 429,
    });
    controller.abort();
    expect(pool.running).toBe(2);
    await expect(second).rejects.toMatchObject({ code: "unavailable" });
    const value = await first;
    expect(value.text).toContain("durable storage");
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
    await pool.close();
  }
  expect(pool.running).toBe(0);
  await expect(pool.extract("web", "closed.html", Buffer.from("<p>Closed</p>"))).rejects.toMatchObject({
    code: "unavailable",
  });
}, 20000);

test("a real parser deadline terminates its worker and closes without releasing a live slot early", async () => {
  const pool = new CreativeTextWorkers(1, 1);
  try {
    await expect(pool.extract("web", "timeout.html", large())).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await pool.close();
  }
  expect(pool.running).toBe(0);
});

test("the compiled server layout resolves its fixed source worker without host path configuration", async () => {
  await mkdir("dist", { recursive: true });
  const name = "creative-worker-probe-" + randomUUID() + ".mjs",
    path = resolve("dist", name);
  try {
    const built = await Bun.build({
      entrypoints: ["src/server/creative/assets/projection.ts"],
      target: "bun",
      outdir: "dist",
      naming: name,
    });
    expect(built.success).toBeTrue();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const {CreativeTextWorkers}=await import(${JSON.stringify(path)}); const p=new CreativeTextWorkers(); try{console.log(JSON.stringify(await p.extract("web","index.html",new TextEncoder().encode("<p>Compiled original</p>"))))}finally{await p.close()}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).text).toBe("Compiled original");
  } finally {
    await rm(path, { force: true });
  }
}, 20000);
