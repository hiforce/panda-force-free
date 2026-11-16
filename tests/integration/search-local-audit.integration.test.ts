import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalTextIndex } from "../../src/server/search/providers/local.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";

test("a real local worker deeply audits warm cached generations and invalidates corrupt bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-local-audit-")),
    provider = new LocalTextIndex(root, resolve("src/server/search/worker-entry.ts")),
    analyzer = builtinAnalyzer(),
    signal = new AbortController().signal;
  try {
    const progress: [number, number][] = [];
    const ref = await provider.build(
        "e".repeat(64),
        [
          {
            id: "doc",
            title: "Warm cached source",
            text: "Auditable English content",
            version: "version1",
            locale: "en",
            path: "source.md",
            ancestors: [],
            updatedAt: 1,
          },
        ],
        analyzer,
        signal,
        (completed, total) => progress.push([completed, total]),
      ),
      path = join(root, ref.name + ".json");
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(await provider.query(ref, "cached", analyzer, 10, signal)).toHaveLength(1);
    expect((await provider.audit(ref, analyzer, signal)).checks).toContain("bytes");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replaceAll("version1", "version2"));
    await expect(provider.audit(ref, analyzer, signal)).rejects.toMatchObject({ reason: "corrupt" });
    await expect(provider.query(ref, "cached", analyzer, 10, signal)).rejects.toMatchObject({ reason: "corrupt" });
    await writeFile(path, original);
    expect((await provider.audit(ref, analyzer, signal)).count).toBe(1);
    await expect(provider.audit({ provider: ref.provider, name: ref.name }, analyzer, signal)).rejects.toMatchObject({
      reason: "unverified",
    });
    await unlink(path);
    await expect(provider.audit(ref, analyzer, signal)).rejects.toMatchObject({ reason: "missing" });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelled local work retains its admission slots until reply or the isolated worker is reaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-worker-cancel-")),
    entry = join(root, "stalled.ts");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const root=process.argv[2];
appendFileSync(root+'/starts',String(process.pid)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='health')process.stdout.write(JSON.stringify({id:request.id,result:true})+'\\n');
 else if(request.method!=='cancel')appendFileSync(root+'/requests',String(request.id)+'\\n');
});
`,
  );
  const provider = new LocalTextIndex(root, entry),
    analyzer = builtinAnalyzer(),
    controller = new AbortController();
  try {
    const requests = Array.from({ length: 16 }, () =>
      provider.audit({ name: "f".repeat(64), provider: "local" }, analyzer, controller.signal),
    );
    const before = Date.now();
    while ((await readFile(join(root, "requests"), "utf8").catch(() => "")).trim().split("\n").length !== 16) {
      if (Date.now() - before > 3000) throw Error("Stalled test worker did not receive all requests");
      await Bun.sleep(20);
    }
    controller.abort();
    const stopped = await Promise.allSettled(requests);
    expect(stopped.every((result) => result.status === "rejected")).toBeTrue();
    await expect(provider.health()).rejects.toMatchObject({ code: "limit" });
    await Bun.sleep(2300);
    expect(await provider.health()).toBeTrue();
    expect((await readFile(join(root, "starts"), "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
