import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { officeFixture } from "../support/office-presentation.js";
import { FileCreativeAssets } from "../../src/server/creative/assets/service.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectCreationFile, projectCreationHtml } from "../../src/server/project-content/paths.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { creativeVersion, encodeCreativeAsset } from "../../src/server/creative/assets/codec.js";

const input = (kind: "web" | "slides" = "web") => ({
  id: "c-" + randomUUID(),
  operationId: randomUUID(),
  expectedVersion: null,
  kind,
  title: "Actual authored source",
  locale: "en",
  name: kind === "web" ? "index.html" : "deck.pptx",
  bytes:
    kind === "web"
      ? Buffer.from("<h1>Requirements</h1><p>A durable original.</p>")
      : Buffer.from(officeFixture({ slides: 2 }).bytes()),
});

test("authored HTML text enters Git, native PPTX and resource bytes stay outside, and retries survive reopen", async () => {
  const f = await projectFileApiFixture();
  try {
    const service = f.application().creations,
      web = input(),
      slides = input("slides"),
      a = await service.save("alice", "project-1", {
        ...web,
        resources: [{ name: "image.png", bytes: Buffer.from([1, 2, 3]) }],
      }),
      b = await service.save("alice", "project-1", slides),
      head = await f.snapshots.head();
    f.reopen();
    expect(await f.application().creations.save("alice", "project-1", slides)).toEqual(b);
    expect(await f.snapshots.head()).toBe(head);
    const entries = await f.snapshots.entries(head);
    expect(entries.some((e) => e.path === projectCreationHtml(web.id))).toBeTrue();
    expect(
      entries.some((e) => e.path.endsWith(".pptx") || e.path.includes("blobs") || e.path.endsWith("image.png")),
    ).toBeFalse();
    const text = await f.application().creations.read("project-1", a.asset.id);
    expect(text.bytes).toEqual(web.bytes);
    expect(text.resources[0]!.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect((await service.read("project-1", b.asset.id)).bytes).toEqual(slides.bytes);
    const source = {
        id: a.asset.id,
        version: a.asset.version,
        kind: "asset" as const,
        title: a.asset.title,
        text: text.text,
        sections: text.sections,
      },
      draft = validateKnowledgeEvidence(
        {
          schema: 1,
          title: "Fact",
          summary: "",
          uncertainties: [],
          claims: [
            {
              id: "fact",
              kind: "source",
              text: "Durability",
              evidence: [{ sourceId: source.id, version: source.version, quote: "durable", section: "web-body" }],
            },
          ],
        },
        [source],
      );
    expect(text.text.slice(draft.claims[0]!.evidence[0]!.start, draft.claims[0]!.evidence[0]!.end)).toBe("durable");
    expect(
      (await f.application().queries.savedSnapshot("project-1")).documents.some((d) => d.document.id === web.id),
    ).toBeFalse();
    expect((await service.list("project-1")).assets.map((r) => r.kind).sort()).toEqual(["slides", "web"]);
  } finally {
    await f.close();
  }
}, 20000);

test("versions reject concurrent writers and trashed originals disappear without changing document rules", async () => {
  const f = await projectFileApiFixture();
  try {
    const service = f.application().creations,
      web = input(),
      created = await service.save("alice", "project-1", web),
      writers = await Promise.allSettled(
        ["One", "Two"].map((title) =>
          service.save("alice", "project-1", {
            ...web,
            operationId: randomUUID(),
            expectedVersion: created.asset.version,
            title,
          }),
        ),
      );
    expect(writers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = await service.read("project-1", web.id),
      trashed = await service.setState("alice", "project-1", web.id, current.asset.version, "trashed", randomUUID());
    expect((await service.list("project-1")).assets).toEqual([]);
    await expect(service.read("project-1", web.id)).rejects.toMatchObject({ code: "notFound" });
    await service.setState("alice", "project-1", web.id, trashed.asset.version, "saved", randomUUID());
    expect((await service.read("project-1", web.id)).bytes).toEqual(web.bytes);
  } finally {
    await f.close();
  }
}, 20000);

test("copies own their project version and blobs; source changes, revocation and tampered bytes cannot silently pass", async () => {
  const f = await projectFileApiFixture();
  try {
    const source = f.application().creations,
      deck = input("slides"),
      saved = await source.save("alice", "project-1", deck),
      owned = await createOwnedProjectDirectory(f.root, "target"),
      projects = new DocumentFileProjects(f.root, (id) => {
        if (id !== "target") throw Error("Not authorized");
      }),
      target = new FileCreativeAssets(projects, f.assetRoot),
      targetId = "c-" + randomUUID(),
      operationId = randomUUID(),
      copy = await target.copyFrom(
        source,
        "alice",
        { project: "project-1", id: deck.id, version: saved.asset.version },
        "target",
        targetId,
        operationId,
      );
    expect(copy.asset.copiedFrom).toEqual({
      project: "project-1",
      id: deck.id,
      version: saved.asset.version,
      commit: saved.commit,
    });
    expect(copy.asset.version).not.toBe(saved.asset.version);
    await source.save("alice", "project-1", {
      ...deck,
      expectedVersion: saved.asset.version,
      title: "Changed original",
      operationId: randomUUID(),
    });
    const copiedHead = await new ProjectGitSnapshots(owned).head();
    expect(
      await target.copyFrom(
        source,
        "alice",
        { project: "project-1", id: deck.id, version: saved.asset.version },
        "target",
        targetId,
        operationId,
      ),
    ).toEqual(copy);
    expect(await new ProjectGitSnapshots(owned).head()).toBe(copiedHead);
    expect((await target.read("target", targetId)).asset.title).toBe("Actual authored source");
    expect((await target.read("target", targetId)).bytes).toEqual(deck.bytes);
    f.grants.clear();
    await expect(
      target.copyFrom(
        source,
        "alice",
        { project: "project-1", id: deck.id, version: saved.asset.version },
        "target",
        "c-" + randomUUID(),
        randomUUID(),
      ),
    ).rejects.toThrow();
    const blobs = join(f.assetRoot, "projects", "target", "blobs", copy.asset.source.digest);
    await writeFile(blobs, "corrupted");
    await expect(target.read("target", targetId)).rejects.toThrow();
    expect((await new ProjectGitSnapshots(owned).entries(copy.commit)).map((e) => e.path)).toEqual([
      projectCreationFile(targetId),
    ]);
    expect(await readFile(join(owned.directory, projectCreationFile(targetId)), "utf8")).toContain(
      copy.asset.source.digest,
    );
  } finally {
    await f.close();
  }
}, 20000);

test("list pages are bounded metadata snapshots and never parse an unrelated bad original", async () => {
  const f = await projectFileApiFixture();
  try {
    const service = f.application().creations,
      original = input(),
      a = await service.save("alice", "project-1", original);
    await f.project.coordinator.plan(
      {
        operationId: randomUUID(),
        author: { name: "Test", email: "test@example.test" },
        message: "Stage bounded history fixtures",
        intent: randomUUID(),
      },
      async () => {
        return {
          changes: Array.from({ length: 55 }, () => {
            const { version: _version, ...content } = a.asset,
              id = "c-" + randomUUID(),
              value = { ...content, id };
            return {
              path: projectCreationFile(id),
              content: encodeCreativeAsset({ ...value, version: creativeVersion(value) }),
            };
          }),
        };
      },
    );
    await writeFile(join(f.owned.directory, projectCreationHtml(a.asset.id)), "tampered original");
    const first = await service.list("project-1");
    expect(first.assets).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list("project-1", first.nextCursor!);
    expect(second.assets).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.assets, ...second.assets].map((r) => r.id)).size).toBe(56);
    await expect(service.list("project-1", first.nextCursor!, "trashed")).rejects.toMatchObject({ code: "conflict" });
    await expect(service.read("project-1", a.asset.id)).rejects.toThrow();
    const trashed = await service.setState("alice", "project-1", a.asset.id, a.asset.version, "trashed", randomUUID());
    const trash = await service.list("project-1", undefined, "trashed");
    const nextTrash = trash.nextCursor ? await service.list("project-1", trash.nextCursor, "trashed") : null;
    expect([...trash.assets, ...(nextTrash?.assets ?? [])].map((r) => r.id)).toEqual([trashed.asset.id]);
    await expect(service.list("project-1", first.nextCursor!)).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await f.close();
  }
}, 20000);
