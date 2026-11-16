import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nativeGenerationFixture } from "../support/native-generation-fixture.js";
import { officeFixture } from "../support/office-presentation.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import type { CreativeAsset } from "../../src/shared/creative/assets.js";

const selection = (kind: "web" | "slides") => ({
  ...defaultGenerationPolicy().selection,
  originals: { contentKinds: [kind], all: true, ids: [], exclude: [] },
});
async function save(
  f: Awaited<ReturnType<typeof nativeGenerationFixture>>,
  kind: "web" | "slides",
  prior?: CreativeAsset,
  text = "Original version",
) {
  return (
    await f.app.creations.save("alice", "project-1", {
      id: prior?.id ?? "c-" + randomUUID(),
      operationId: randomUUID(),
      expectedVersion: prior?.version ?? null,
      kind,
      name: kind === "web" ? "guide.html" : "guide.pptx",
      title: "Native rule source",
      locale: "en",
      bytes:
        kind === "web"
          ? Buffer.from("<h1>Evidence</h1><p>" + text + "</p>")
          : Buffer.from(officeFixture({ slides: text === "Original version" ? 1 : 2 }).bytes()),
      resources: [],
    })
  ).asset;
}

test("explicit native rules observe metadata, coalesce final saves and retain typed immutable admissions across restart", async () => {
  const f = await nativeGenerationFixture();
  try {
    let asset = await save(f, "web");
    await save(f, "slides");
    const rule = { enabled: true, purpose: "Explain the current native source", selection: selection("web") },
      preview = await f.c.settings.preview("alice", "project-1", {
        ...defaultGenerationPolicy(),
        ...rule,
        backfill: false,
      });
    expect(preview.counts).toEqual({ documents: 0, web: 1, slides: 0 });
    expect(preview.documents).toEqual([]);
    expect(f.parsed).toBe(0);
    await f.configure(rule);
    f.advance(2000);
    await f.submit();
    expect(await f.c.tasks.list("alice", "project-1")).toHaveLength(0);
    expect(f.parsed).toBe(0);
    asset = await save(f, "web", asset, "Interim version");
    f.advance();
    await f.scan();
    asset = await save(f, "web", asset, "Final saved version");
    f.advance();
    await f.scan();
    expect(f.parsed).toBe(0);
    const queued = f.db.query("SELECT operationId,sourceKind FROM knowledge_generation_jobs").get() as {
      operationId: string;
      sourceKind: string;
    };
    expect(queued.sourceKind).toBe("web");
    f.restart();
    f.advance(2000);
    await f.submit();
    const tasks = await f.c.tasks.list("alice", "project-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.origin).toMatchObject({ kind: "rule", sourceId: asset.id, sourceKind: "web", manual: false });
    expect(tasks[0]!.origin).not.toHaveProperty("documentId");
    const input = await f.files.input(f.c.ledger.get("alice", tasks[0]!.id).inputDigest);
    expect(input.scope.contentKinds).toEqual(["web"]);
    expect(input.sources[0]!.version).toBe(asset.version);
    expect(input.sources[0]!.text).toContain("Final saved version");
    expect(f.db.query("SELECT operationId FROM knowledge_submissions").get()).toEqual({
      operationId: queued.operationId,
    });
    f.restart();
    f.advance();
    await f.scan();
    await f.submit();
    expect(await f.c.tasks.list("alice", "project-1")).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect((await f.c.settings.policy("alice", "project-1")).selection.originals).toEqual(selection("web").originals);
    const adopted = await f.c.tasks.submit("alice", {
      id: randomUUID(),
      project: "project-1",
      ids: [asset.id],
      contentKinds: ["web"],
      purpose: rule.purpose,
    });
    expect(adopted.id).toBe(tasks[0]!.id);
    expect(adopted.origin).toMatchObject({ sourceKind: "web", manual: true });
    await f.configure({ enabled: false });
    expect((await f.c.tasks.status("alice", adopted.id)).state).toBe("queued");
  } finally {
    await f.close();
  }
}, 30000);

test("native exclusion, trash and restoration change the desired queue without changing document defaults or review policy", async () => {
  const f = await nativeGenerationFixture();
  try {
    let asset = await save(f, "slides");
    await f.configure({
      enabled: true,
      purpose: "Only chosen presentation",
      selection: { ...selection("slides"), originals: { ...selection("slides").originals, exclude: [asset.id] } },
      backfill: true,
    });
    f.advance(2000);
    await f.submit();
    expect(await f.c.tasks.list("alice", "project-1")).toHaveLength(0);
    await f.configure({ selection: selection("slides"), backfill: true });
    f.advance(2000);
    await f.submit();
    const first = (await f.c.tasks.list("alice", "project-1"))[0]!;
    expect(first.origin).toMatchObject({ sourceKind: "slides" });
    asset = (await f.app.creations.setState("alice", "project-1", asset.id, asset.version, "trashed", randomUUID()))
      .asset;
    f.advance();
    await f.scan();
    expect((await f.c.tasks.status("alice", first.id)).state).toBe("cancelled");
    expect(f.db.query("SELECT COUNT(*) count FROM knowledge_generation_jobs").get()).toEqual({ count: 0 });
    asset = (await f.app.creations.setState("alice", "project-1", asset.id, asset.version, "saved", randomUUID()))
      .asset;
    f.advance();
    await f.scan();
    f.advance(2000);
    await f.submit();
    expect(await f.c.tasks.list("alice", "project-1")).toHaveLength(2);
    expect(f.db.query("SELECT * FROM knowledge_review_policies").all()).toEqual([]);
    expect((await f.c.settings.policy("alice", "project-1")).selection.all).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

test("disabling native rules or revoking source access during capture atomically fences task, origin and quota", async () => {
  for (const reason of ["disable", "revoke"] as const) {
    const f = await nativeGenerationFixture();
    try {
      await save(f, "web");
      await f.configure({ enabled: true, purpose: "Fenced rule", selection: selection("web"), backfill: true });
      f.advance(2000);
      f.hook(async () => {
        if (reason === "disable") await f.configure({ enabled: false });
        else f.grants.delete("project-1");
      });
      await expect(f.submit()).rejects.toThrow();
      expect(f.db.query("SELECT COUNT(*) count FROM knowledge_tasks").get()).toEqual({ count: 0 });
      expect(f.db.query("SELECT COUNT(*) count FROM knowledge_generation_origins").get()).toEqual({ count: 0 });
      expect(f.db.query("SELECT COUNT(*) count FROM knowledge_submissions").get()).toEqual({ count: 0 });
      expect(f.c.admission.usage("alice", "project-1", f.now())).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 30000);

test("native leases cannot be relabeled and daily admission is shared across selected original types", async () => {
  const f = await nativeGenerationFixture();
  try {
    await save(f, "web");
    await save(f, "slides");
    await f.configure({
      enabled: true,
      purpose: "One shared native budget",
      selection: {
        ...defaultGenerationPolicy().selection,
        originals: { contentKinds: ["web", "slides"], all: true, ids: [], exclude: [] },
      },
      dailyLimit: 1,
      backfill: true,
    });
    f.advance(2000);
    const lease = f.c.queue.claim(f.now())!,
      forged = {
        ...lease,
        source: { ...lease.source, kind: lease.source.kind === "web" ? ("slides" as const) : ("web" as const) },
      };
    expect(() => f.c.queue.heartbeat(forged, f.now())).toThrow("leaseLost");
    await expect(
      f.c.tasks.submit(
        "alice",
        {
          id: lease.operationId,
          project: "project-1",
          ids: [lease.source.id],
          contentKinds: [lease.source.kind],
          purpose: lease.purpose,
        },
        {
          source: forged.source,
          withSource: async (_commit, create) => create(() => {}),
          commit: (id, created, now) => f.c.admission.admit(forged, id, created, now),
        },
      ),
    ).rejects.toThrow("conflict");
    expect(f.db.query("SELECT COUNT(*) count FROM knowledge_tasks").get()).toEqual({ count: 0 });
    f.c.queue.release(lease, f.now(), f.now());
    f.advance(2000);
    await f.submit();
    f.advance(2000);
    await f.submit();
    expect(await f.c.tasks.list("alice", "project-1")).toHaveLength(1);
    expect(f.c.admission.usage("alice", "project-1", f.now())).toBe(1);
    expect(f.db.query("SELECT COUNT(*) count FROM knowledge_generation_jobs WHERE state='queued'").get()).toEqual({
      count: 1,
    });
  } finally {
    await f.close();
  }
}, 30000);
