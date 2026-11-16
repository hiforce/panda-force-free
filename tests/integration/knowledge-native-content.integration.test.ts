import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { officeFixture } from "../support/office-presentation.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { extractCreativeText } from "../../src/server/creative/assets/projection.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { knowledgeInput } from "../../src/server/knowledge/tasks/input.js";
import { knowledgeRecord, knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import type { KnowledgeRecord, KnowledgeTaskInput } from "../../src/shared/knowledge/tasks.js";

const profile = { id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 180000 };
function record(input: KnowledgeTaskInput): KnowledgeRecord {
  const sources = structuredClone(input.sources.map(({ text: _text, sections: _sections, ...metadata }) => metadata)),
    source = input.sources[0]!,
    quote = source.text.includes("Hello world") ? "Hello world" : "Native knowledge evidence";
  const value: KnowledgeRecord = {
    schema: 1,
    id: input.target.id,
    previousVersion: input.target.expectedVersion,
    taskId: randomUUID(),
    sourceCommit: input.sourceCommit,
    sources,
    version: "",
    approvedAt: 1000,
    approval: { mode: "manual" },
    draft: validateKnowledgeEvidence(
      {
        schema: 1,
        title: "Verified native knowledge",
        summary: "Saved evidence",
        claims: [
          {
            id: "claim",
            kind: "source",
            text: quote,
            evidence: [{ sourceId: source.id, version: source.version, quote, start: source.text.indexOf(quote) }],
          },
        ],
        uncertainties: [],
      },
      input.sources,
    ),
  };
  value.version = knowledgeRecordVersion(value);
  return knowledgeRecord(value);
}
async function setup() {
  const f = await projectFileApiFixture(),
    app = f.application(),
    content = new FileDocumentKnowledgeContent(app.projectContent, app.projectContent, app.originals);
  const saved = await app.creations.save("alice", "project-1", {
    id: "c-" + randomUUID(),
    operationId: randomUUID(),
    expectedVersion: null,
    kind: "web",
    name: "original.html",
    title: "Native source",
    locale: "en",
    bytes: Buffer.from("<main><h1>Native knowledge evidence</h1><script>Untrusted script text</script></main>"),
    resources: [{ name: "figure.png", bytes: Buffer.from("Verified attachment") }],
  });
  const scope = { project: "project-1", ids: [saved.asset.id], contentKinds: ["web" as const] };
  const capture = async () => {
    const value = await content.capture("alice", scope);
    return knowledgeInput({
      schema: 1,
      scope,
      purpose: "Native guide",
      sources: value.sources,
      sourceCommit: value.commit,
      target: value.target,
      profile,
    });
  };
  return { ...f, app, content, saved, scope, capture };
}

test("native knowledge capture preserves typed original bindings and commits approved JSON and Markdown to real Git", async () => {
  const f = await setup();
  try {
    const input = await f.capture(),
      source = input.sources[0]!;
    expect(input.scope.contentKinds).toEqual(["web"]);
    expect(source.binding).toEqual({
      kind: "web",
      path: `creations/${f.saved.asset.id}.panda.json`,
      blob: (await f.snapshots.entries(input.sourceCommit)).find(
        (row) => row.path === `creations/${f.saved.asset.id}.panda.json`,
      )!.blob,
      original: f.saved.asset.source,
      resources: f.saved.asset.resources,
    });
    expect(source.text).toBe("Native knowledge evidence");
    expect(source.text).not.toContain("Untrusted");
    expect(input.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(await f.content.current("alice", input)).toBe(true);
    const output = record(input),
      before = await f.snapshots.head(),
      receipt = await f.content.save("alice", input, output);
    expect(await f.snapshots.parent(receipt.commit)).toBe(before);
    const json = JSON.parse(await readFile(join(f.owned.directory, "knowledge", receipt.id + ".panda.json"), "utf8"));
    expect(json).toEqual(output);
    const projection = await f.content.projection("alice", input, output, receipt);
    expect(projection.sources[0]!.binding).toEqual(source.binding);
    expect(projection.sources[0]!.blob).toBe(source.binding!.blob);
    expect(JSON.stringify(projection)).not.toContain("Native knowledge evidence");
    expect(await readFile(join(f.owned.directory, "knowledge", receipt.id + ".md"), "utf8")).toContain(
      "Native knowledge evidence",
    );
    await f.app.creations.setState(
      "alice",
      "project-1",
      f.saved.asset.id,
      f.saved.asset.version,
      "trashed",
      randomUUID(),
    );
    expect(await f.content.current("alice", input)).toBe(false);
    expect(await f.content.save("alice", input, output)).toEqual(receipt);
    expect((await f.content.recover("alice", input, output))?.projection).toEqual(projection);
  } finally {
    await f.close();
  }
}, 30000);

test("native source bodies, sections and binding metadata cannot be forged into a current approved write", async () => {
  const f = await setup();
  try {
    const input = await f.capture(),
      before = await f.snapshots.head();
    for (const change of [
      (value: KnowledgeTaskInput) => (value.sources[0]!.text += " Invented assertion."),
      (value: KnowledgeTaskInput) => (value.sources[0]!.sections = [{ id: "invented", start: 0, end: 1 }]),
      (value: KnowledgeTaskInput) => (value.sources[0]!.binding!.original!.digest = "b".repeat(64)),
    ]) {
      const forged = structuredClone(input);
      change(forged);
      expect(await f.content.current("alice", forged)).toBe(false);
      await expect(f.content.save("alice", forged, record(forged))).rejects.toMatchObject({
        code: "conflict",
        reason: "sourceChanged",
      });
    }
    const output = record(input);
    output.sources[0]!.binding!.original!.digest = "b".repeat(64);
    output.version = knowledgeRecordVersion(output);
    await expect(f.content.save("alice", input, output)).rejects.toMatchObject({ code: "conflict" });
    expect(await f.snapshots.head()).toBe(before);
    await writeFile(
      join(f.assetRoot, "projects", "project-1", "blobs", f.saved.asset.resources[0]!.digest),
      "Tampered resource",
    );
    await expect(f.content.save("alice", input, record(input))).rejects.toBeTruthy();
    expect(await f.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);

test("PPTX evidence uses actual presentation text and ordinary document-only selection never admits native originals", async () => {
  const f = await setup();
  try {
    await expect(f.content.capture("alice", { project: "project-1", ids: [f.saved.asset.id] })).rejects.toMatchObject({
      code: "notFound",
    });
    const saved = await f.app.creations.save("alice", "project-1", {
      id: "c-" + randomUUID(),
      operationId: randomUUID(),
      expectedVersion: null,
      kind: "slides",
      name: "deck.pptx",
      title: "Native deck",
      locale: "en",
      bytes: Buffer.from(officeFixture({ slides: 2 }).bytes()),
    });
    const scope = { project: "project-1", ids: [saved.asset.id], contentKinds: ["slides" as const] },
      captured = await f.content.capture("alice", scope),
      input = knowledgeInput({
        schema: 1,
        scope,
        purpose: "Slide evidence",
        sources: captured.sources,
        sourceCommit: captured.commit,
        target: captured.target,
        profile,
      });
    expect(input.sources[0]!.binding!.kind).toBe("slides");
    expect(input.sources[0]!.sections).toHaveLength(2);
    expect(input.sources[0]!.text).toContain("Hello world");
    const receipt = await f.content.save("alice", input, record(input));
    expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/);
    f.grants.clear();
    await expect(f.content.capture("alice", scope)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);

test("native knowledge preparation releases the lease and captures a real final Git commit after an overlapping write", async () => {
  const f = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve)),
    paused = new Promise<void>((resolve) => (release = resolve)),
    originals = new FileOriginalQueries(f.app.projectContent, f.assetRoot, async (...args) => {
      enter();
      await paused;
      return extractCreativeText(...args);
    }),
    content = new FileDocumentKnowledgeContent(f.app.projectContent, f.app.projectContent, originals),
    capture = content.capture("alice", f.scope);
  try {
    await entered;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      release();
    }, 5000);
    try {
      const write = await f.project.coordinator.mutate({
        operationId: randomUUID(),
        author: { name: "Writer", email: "writer@example.test" },
        message: "Save independent knowledge data",
        changes: [{ path: "knowledge/parallel.md", content: Buffer.from("Independent saved result.\n") }],
      });
      expect(timedOut).toBe(false);
      release();
      const captured = await capture;
      expect(captured.commit).toBe(write.commit);
      expect(captured.sources[0]!.binding!.blob).toBe(
        (await f.snapshots.entries(write.commit)).find(
          (entry) => entry.path === `creations/${f.saved.asset.id}.panda.json`,
        )!.blob,
      );
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    release();
    await capture;
    await f.close();
  }
}, 30000);
