import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { DocumentFileProjects, type DocumentProjectReads } from "../../src/server/documents/files/projects.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { extractCreativeText } from "../../src/server/creative/assets/projection.js";
import type { SavedSourceParser } from "../../src/server/content-sources/prepared.js";
import { FileCreativeAssetReader } from "../../src/server/creative/assets/reader.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function parserGate(pauseAt = 1) {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const parse: SavedSourceParser = async (...args) => {
    if (++calls === pauseAt) {
      entered.resolve();
      await release.promise;
    }
    return extractCreativeText(...args);
  };
  return { entered: entered.promise, release: release.resolve, parse };
}
const input = () => ({
  id: "c-" + randomUUID(),
  operationId: randomUUID(),
  expectedVersion: null,
  kind: "web" as const,
  title: "Captured original",
  locale: "en",
  name: "original.html",
  bytes: Buffer.from("<h1>Saved evidence</h1><p>Exact original text.</p>"),
});
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );

async function enteredWhileReading(gate: ReturnType<typeof parserGate>, reading: Promise<unknown>) {
  await Promise.race([
    gate.entered,
    reading.then(() => {
      throw Error("The read ended before entering the gated parser");
    }),
  ]);
}

/** A deadline releases a broken implementation so the test can report a lock regression without leaking a reader. */
async function writeWhilePaused(gate: ReturnType<typeof parserGate>, write: () => Promise<unknown>) {
  let releasedByDeadline = false;
  const deadline = setTimeout(() => {
    releasedByDeadline = true;
    gate.release();
  }, 5000);
  try {
    await write();
    expect(releasedByDeadline).toBe(false);
  } finally {
    clearTimeout(deadline);
  }
}

test("native snapshot parsing releases the project lease and unrelated knowledge writes retain its source identity", async () => {
  const f = await projectFileApiFixture(),
    gate = parserGate();
  let reading: ReturnType<typeof settled<Awaited<ReturnType<FileOriginalQueries["snapshot"]>>>> | undefined;
  try {
    const saved = await f.application().creations.save("alice", "project-1", input()),
      queries = new FileOriginalQueries(new DocumentFileProjects(f.root, () => {}), f.assetRoot, gate.parse),
      before = await queries.metadata("project-1", ["web"]);
    reading = settled(queries.snapshot("project-1", ["web"]));
    await enteredWhileReading(gate, reading);
    await writeWhilePaused(gate, () =>
      f.project.coordinator.mutate({
        operationId: randomUUID(),
        author: { name: "Writer", email: "writer@example.test" },
        message: "Save unrelated knowledge data",
        changes: [{ path: "knowledge/independent.md", content: Buffer.from("Independent knowledge output.\n") }],
      }),
    );
    gate.release();
    const result = await reading;
    expect(result.error).toBeNull();
    expect(result.value?.head).toBe(before.head);
    expect(result.value?.sources[0]?.metadata.version).toBe(saved.asset.version);
    expect(result.value?.sources[0]?.text).toContain("Exact original text.");
  } finally {
    gate.release();
    await reading;
    await f.close();
  }
}, 20000);

test("source replacement while a native parser is paused completes and invalidates the old snapshot", async () => {
  const f = await projectFileApiFixture(),
    gate = parserGate();
  let reading: ReturnType<typeof settled<Awaited<ReturnType<FileOriginalQueries["snapshot"]>>>> | undefined;
  try {
    const source = input(),
      saved = await f.application().creations.save("alice", "project-1", source),
      queries = new FileOriginalQueries(new DocumentFileProjects(f.root, () => {}), f.assetRoot, gate.parse);
    reading = settled(queries.snapshot("project-1", ["web"]));
    await enteredWhileReading(gate, reading);
    await writeWhilePaused(gate, () =>
      f.application().creations.save("alice", "project-1", {
        ...source,
        operationId: randomUUID(),
        expectedVersion: saved.asset.version,
        bytes: Buffer.from("<h1>Updated source</h1>"),
      }),
    );
    gate.release();
    expect((await reading).error).toMatchObject({ code: "conflict" });
    expect((await queries.current("project-1", [source.id], ["web"]))[0]?.text).toBe("Updated source");
  } finally {
    gate.release();
    await reading;
    await f.close();
  }
}, 20000);

test("revocation and cancellation during lease-free parsing admit no result or additional cancelled reads", async () => {
  const f = await projectFileApiFixture();
  try {
    const source = input();
    await f.application().creations.save("alice", "project-1", source);
    for (const [target, mode] of [
      ["search", "revoke"],
      ["search", "cancel"],
      ["preview", "revoke"],
      ["preview", "cancel"],
    ] as const) {
      const gate = parserGate(),
        controller = new AbortController();
      let allowed = true,
        reads = 0;
      const projects = new DocumentFileProjects(f.root, () => {
          if (!allowed) throw new DocumentError("notFound", 404);
        }),
        readsPort: DocumentProjectReads = {
          authorize: projects.authorize.bind(projects),
          ifPresent: async (project, work) => {
            reads++;
            return projects.ifPresent(project, work);
          },
        },
        queries = new FileOriginalQueries(readsPort, f.assetRoot, gate.parse),
        reader = new FileCreativeAssetReader(readsPort, f.assetRoot, gate.parse),
        reading = settled<unknown>(
          target === "search"
            ? queries.current("project-1", [source.id], ["web"], controller.signal)
            : reader.read("project-1", source.id, controller.signal, true),
        );
      try {
        await enteredWhileReading(gate, reading);
        const priorReads = reads;
        if (mode === "revoke") allowed = false;
        else controller.abort();
        gate.release();
        expect((await reading).error).toMatchObject({ code: mode === "revoke" ? "notFound" : "unavailable" });
        if (mode === "cancel") expect(reads).toBe(priorReads);
      } finally {
        gate.release();
        await reading;
      }
    }
  } finally {
    await f.close();
  }
}, 30000);

test("static native preview parsing releases the lease and source changes invalidate its captured bytes", async () => {
  const f = await projectFileApiFixture();
  try {
    const source = input(),
      saved = await f.application().creations.save("alice", "project-1", source);
    for (const mode of ["unrelated", "replace"] as const) {
      const gate = parserGate(),
        reader = new FileCreativeAssetReader(new DocumentFileProjects(f.root, () => {}), f.assetRoot, gate.parse),
        reading = settled(reader.read("project-1", source.id, undefined, true));
      try {
        await enteredWhileReading(gate, reading);
        await writeWhilePaused(gate, () =>
          mode === "unrelated"
            ? f.project.coordinator.mutate({
                operationId: randomUUID(),
                author: { name: "Writer", email: "writer@example.test" },
                message: "Save independent preview data",
                changes: [{ path: "knowledge/preview.md", content: Buffer.from("Independent output.\n") }],
              })
            : f.application().creations.save("alice", "project-1", {
                ...source,
                operationId: randomUUID(),
                expectedVersion: saved.asset.version,
                bytes: Buffer.from("<h1>Replacement</h1>"),
              }),
        );
        gate.release();
        const result = await reading;
        if (mode === "replace") expect(result.error).toMatchObject({ code: "conflict" });
        else {
          expect(result.error).toBeNull();
          expect(result.value?.asset.version).toBe(saved.asset.version);
          expect(result.value?.previewHtml).toContain("Saved evidence");
          expect(result.value?.commit).toBe(saved.commit);
        }
      } finally {
        gate.release();
        await reading;
      }
    }
  } finally {
    await f.close();
  }
}, 30000);

test("independent original copies remain usable when text parsing is unavailable", async () => {
  const f = await projectFileApiFixture();
  try {
    const source = input(),
      saved = await f.application().creations.save("alice", "project-1", source),
      reader = new FileCreativeAssetReader(new DocumentFileProjects(f.root, () => {}), f.assetRoot, async () => {
        throw Error("Parser unavailable");
      });
    await expect(reader.read("project-1", source.id)).rejects.toThrow("Parser unavailable");
    const copied = await f
      .application()
      .creations.copyFrom(
        reader,
        "alice",
        { project: "project-1", id: source.id, version: saved.asset.version },
        "project-1",
        "c-" + randomUUID(),
        randomUUID(),
      );
    const bytes = await reader.original("project-1", copied.asset.id);
    expect(bytes.bytes).toEqual(source.bytes);
    expect(copied.asset.copiedFrom).toMatchObject({
      project: "project-1",
      id: source.id,
      version: saved.asset.version,
      commit: saved.commit,
    });
  } finally {
    await f.close();
  }
}, 20000);

test("native resources are checked again after parsing even when their metadata did not change", async () => {
  const f = await projectFileApiFixture(),
    gate = parserGate();
  let reading: ReturnType<typeof settled<Awaited<ReturnType<FileOriginalQueries["snapshot"]>>>> | undefined;
  try {
    const source = input(),
      saved = await f.application().creations.save("alice", "project-1", {
        ...source,
        resources: [{ name: "figure.png", bytes: Buffer.from("Verified image bytes") }],
      }),
      queries = new FileOriginalQueries(new DocumentFileProjects(f.root, () => {}), f.assetRoot, gate.parse),
      before = await queries.metadata("project-1", ["web"]);
    reading = settled(queries.snapshot("project-1", ["web"]));
    await enteredWhileReading(gate, reading);
    await writeFile(
      join(f.assetRoot, "projects", "project-1", "blobs", saved.asset.resources[0]!.digest),
      "Corrupt resource bytes",
    );
    gate.release();
    expect((await reading).error).not.toBeNull();
    expect(await queries.metadata("project-1", ["web"])).toEqual(before);
  } finally {
    gate.release();
    await reading;
    await f.close();
  }
}, 20000);

test("a change to an earlier parsed batch cannot escape the final whole-selection fence", async () => {
  const f = await projectFileApiFixture(),
    gate = parserGate(5);
  let reading: ReturnType<typeof settled<Awaited<ReturnType<FileOriginalQueries["snapshot"]>>>> | undefined;
  try {
    const originals = [];
    for (let n = 0; n < 5; n++) originals.push(await f.application().creations.save("alice", "project-1", input()));
    originals.sort((a, b) => a.asset.id.localeCompare(b.asset.id));
    const first = originals[0]!.asset,
      queries = new FileOriginalQueries(new DocumentFileProjects(f.root, () => {}), f.assetRoot, gate.parse);
    reading = settled(queries.snapshot("project-1", ["web"]));
    await enteredWhileReading(gate, reading);
    await writeWhilePaused(gate, () =>
      f.application().creations.setState("alice", "project-1", first.id, first.version, "trashed", randomUUID()),
    );
    gate.release();
    expect((await reading).error).toMatchObject({ code: "conflict" });
  } finally {
    gate.release();
    await reading;
    await f.close();
  }
}, 30000);
