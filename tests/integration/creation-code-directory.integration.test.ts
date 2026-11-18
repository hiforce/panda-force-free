import { creationDocumentArtifact } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { creationAppFixture } from "../support/creation-app.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { creationCodeDirectories } from "../../src/server/creation/integration/code-directories.js";
import { CreationError } from "../../src/server/creation/contracts.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";

async function fixture() {
  let allowed = true,
    failAfterPublication = false,
    code = "";
  const f = await creationAppFixture({
    content(files, root) {
      code = join(root, "code");
      mkdirSync(join(code, "docs"), { recursive: true });
      return {
        documents: creationFileDocuments(files.application()),
        directories: creationCodeDirectories({
          root: async () => code,
          authorize: async (task) => {
            if (failAfterPublication && readdirSync(join(code, "docs")).some((name) => name.endsWith(".md"))) {
              allowed = false;
              failAfterPublication = false;
            }
            if (!allowed || task.owner !== "operator:test-user") throw new CreationError("notFound");
          },
        }),
      };
    },
  });
  return {
    ...f,
    code,
    failAfterPublication() {
      failAfterPublication = true;
    },
    allow(value: boolean) {
      allowed = value;
    },
  };
}
test("a requested code-directory move removes the old Markdown and restarted older-round continuations edit the same file", async () => {
  const f = await fixture();
  let firstCwd = "",
    move = false,
    round = 0;
  try {
    f.onRun(async (input, callbacks, scope) => {
      if (!firstCwd) firstCwd = callbacks.directory!.path;
      expect(callbacks.directory!.path).toBe(firstCwd);
      expect(input.tools.some((tool) => tool.name === "panda_document_file_directory")).toBe(true);
      let directory: string | undefined;
      if (move) {
        const result = await callbacks.call({
          ...scope,
          callId: randomUUID(),
          name: "panda_document_file_directory",
          arguments: { directory: "docs" },
        });
        directory = JSON.parse(result.text).directory;
        expect(directory).toBe(join(f.code, "docs"));
      }
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      await callbacks.call({
        ...scope,
        callId: randomUUID(),
        name: "panda_documents_create",
        arguments: {
          title: "Portable source",
          body: richDocumentFromMarkdown("Writing round " + ++round),
          ...(directory ? { fileDirectory: directory } : {}),
        },
      });
    });
    const first = await f.create("Write a document"),
      original = await f.until(first.request.id, (task) => task.state === "succeeded");
    const before = creationDocumentArtifact(original.artifact)!.file!.path;
    move = true;
    const id = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/follow-up", "POST", {
          taskId: original.id,
          id,
          prompt: "Move the same Markdown file into the code docs directory",
        })
      ).status,
    ).toBe(202);
    const archived = await f.until(id, (task) => task.state === "succeeded" || Boolean(task.failure));
    expect(archived.failure).toBeNull();
    const path = join(f.code, "docs", basename(before));
    expect(creationDocumentArtifact(archived.artifact)?.file?.path).toBe(path);
    expect(creationDocumentArtifact(archived.artifact)?.documentId).toBe(
      creationDocumentArtifact(original.artifact)?.documentId,
    );
    expect(await lstat(before).catch(() => null)).toBeNull();
    expect(await readFile(path, "utf8")).toContain("Writing round 2");
    await f.restart();
    move = false;
    const next = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/follow-up", "POST", {
          taskId: original.id,
          id: next,
          prompt: "Update the current document from this older writing round",
        })
      ).status,
    ).toBe(202);
    const updated = await f.until(next, (task) => task.state === "succeeded" || Boolean(task.failure));
    expect(updated.failure).toBeNull();
    expect(updated.artifact).toMatchObject({
      documentId: creationDocumentArtifact(original.artifact)!.documentId,
      file: { path },
    });
    expect(await readFile(path, "utf8")).toContain("Writing round 3");
    expect((await readdir(dirname(path))).filter((name) => name.endsWith(".md"))).toEqual([basename(path)]);
    expect((await readdir(dirname(before))).filter((name) => name.endsWith(".md"))).toHaveLength(0);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60000);

for (const kind of ["foreign", "equal", "symlink", "outside", "revoked"] as const)
  test(`a ${kind} code target preserves the original document and user files`, async () => {
    const f = await fixture();
    try {
      const first = await f.create("Write the original"),
        original = await f.until(first.request.id, (task) => task.state === "succeeded"),
        path = creationDocumentArtifact(original.artifact)!.file!.path,
        target = join(f.code, "docs", basename(path)),
        text = await readFile(path, "utf8"),
        document = await f.files
          .application()
          .queries.detail("project-1", creationDocumentArtifact(original.artifact)!.documentId);
      if (kind === "foreign" || kind === "equal")
        await writeFile(target, kind === "equal" ? text : "Keep this user file", { flag: "wx" });
      if (kind === "symlink") await symlink(path, target);
      if (kind === "revoked") f.allow(false);
      f.onRun(async (_input, callbacks, scope) => {
        await callbacks.call({
          ...scope,
          callId: randomUUID(),
          name: "panda_documents_create",
          arguments: {
            title: "Changed",
            body: richDocumentFromMarkdown("New generated content"),
            fileDirectory: kind === "outside" ? join(f.code, "..") : "docs",
          },
        });
      });
      const id = randomUUID();
      expect(
        (
          await f.files.call("/api/document-creations/follow-up", "POST", {
            taskId: original.id,
            id,
            prompt: "Move into docs",
          })
        ).status,
      ).toBe(202);
      const stopped = await f.until(id, (task) => Boolean(task.failure));
      expect(stopped.artifact).toBeNull();
      expect(await readFile(path, "utf8")).toBe(text);
      expect(
        await f.files
          .application()
          .queries.detail("project-1", creationDocumentArtifact(original.artifact)!.documentId),
      ).toEqual(document);
      if (kind === "foreign") expect(await readFile(target, "utf8")).toBe("Keep this user file");
      if (kind === "equal") expect(await readFile(target, "utf8")).toBe(text);
      if (kind === "symlink") expect((await lstat(target)).isSymbolicLink()).toBe(true);
    } finally {
      await f.close();
    }
  }, 60000);

test("original images remain relative and byte-identical after a code-directory move; manual destination edits stop subsequent application changes", async () => {
  const f = await fixture();
  try {
    const first = await f.create("Write an illustrated document"),
      original = await f.until(first.request.id, (task) => task.state === "succeeded"),
      app = f.files.application(),
      documentId = creationDocumentArtifact(original.artifact)!.documentId,
      pixels = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#407090" } })
        .png()
        .toBuffer(),
      image = await app.assets.upload(
        "operator:test-user",
        "project-1",
        documentId,
        "Original.png",
        randomUUID(),
        pixels,
      ),
      bytes = (await app.assets.content("project-1", image.id)).bytes,
      illustrated = richDocumentFromMarkdown("Preserve the original section");
    illustrated.document.content!.push({
      type: "image",
      attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Original diagram", title: "" },
    });
    const opened = await app.queries.editor("project-1", documentId);
    await app.editor.autosave("operator:test-user", "project-1", documentId, {
      operationId: randomUUID(),
      version: opened.draft.version,
      baseRevisionId: opened.saved.revision.id,
      working: { title: original.artifact!.title!, locale: "en", content: "", resources: [], body: illustrated },
    });
    const draft = await app.queries.editor("project-1", documentId);
    await app.editor.save("operator:test-user", "project-1", documentId, {
      operationId: randomUUID(),
      draftVersion: draft.draft.version,
      revisionId: draft.saved.revision.id,
    });
    f.onRun(async (_input, callbacks, scope) => {
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      await callbacks.call({
        ...scope,
        callId: randomUUID(),
        name: "panda_documents_create",
        arguments: { title: "Do not rename", body: illustrated, fileDirectory: "docs" },
      });
    });
    const id = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/follow-up", "POST", {
          taskId: original.id,
          id,
          prompt: "Archive the illustrated Markdown into the current code docs directory",
        })
      ).status,
    ).toBe(202);
    const moved = await f.until(id, (task) => task.state === "succeeded" || Boolean(task.failure));
    expect(moved.failure).toBeNull();
    const path = creationDocumentArtifact(moved.artifact)!.file!.path,
      markdown = await readFile(path, "utf8"),
      relative = markdown.match(/\]\((creation-assets-[a-f0-9-]+\/[a-f0-9]+\.png)\)/)?.[1];
    expect(relative).toBeTruthy();
    expect(new Uint8Array(await readFile(join(dirname(path), relative!)))).toEqual(new Uint8Array(bytes));
    expect(creationDocumentArtifact((await f.task(original.id)).artifact)?.file?.path).toBe(path);
    expect((await f.task(original.id)).workspaceDirectory).toBe(
      dirname(creationDocumentArtifact(original.artifact)!.file!.path),
    );
    await f.restart();
    expect(creationDocumentArtifact((await f.task(original.id)).artifact)?.file?.path).toBe(path);
    const before = await f.files.application().queries.detail("project-1", documentId);
    await writeFile(path, "Manual code-directory correction");
    const next = randomUUID();
    expect(
      (
        await f.files.call("/api/document-creations/follow-up", "POST", {
          taskId: moved.id,
          id: next,
          prompt: "Add more details",
        })
      ).status,
    ).toBe(202);
    const stopped = await f.until(next, (task) => Boolean(task.failure));
    expect(stopped.failure).toBe("fileChanged");
    expect(await readFile(path, "utf8")).toBe("Manual code-directory correction");
    expect(await f.files.application().queries.detail("project-1", documentId)).toEqual(before);
  } finally {
    await f.close();
  }
}, 60000);

test("an interrupted code-file handoff cannot complete its goal; restart retries the saved primary without another engine run", async () => {
  const f = await fixture(),
    ready = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  try {
    f.failAfterPublication();
    f.onRun(async (_input, callbacks, scope) => {
      ready.resolve();
      await proceed.promise;
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      await callbacks.call({
        ...scope,
        callId: randomUUID(),
        name: "panda_documents_create",
        arguments: {
          title: "Recover this original",
          body: richDocumentFromMarkdown("Keep the same saved source"),
          fileDirectory: "docs",
        },
      });
    });
    const first = await f.create("Write the document and move its Markdown into code docs");
    await ready.promise;
    expect(
      (
        await f.files.call("/api/document-creations/goal", "POST", {
          taskId: first.request.id,
          id: randomUUID(),
          action: "create",
          objective: "Save and move the same document file",
        })
      ).status,
    ).toBe(200);
    proceed.resolve();
    const blocked = await f.until(first.request.id, (task) => Boolean(task.failure));
    expect(blocked.state).toBe("committing");
    expect(blocked.artifact).toBeNull();
    expect(blocked.goal?.status).not.toBe("completed");
    const documents = (await f.files.application().navigation.tree("project-1")).nodes;
    expect(documents).toHaveLength(1);
    const saved = await f.files.application().queries.detail("project-1", documents[0]!.documentId);
    f.allow(true);
    await f.restart();
    expect(
      (await f.files.call("/api/document-creations/retry", "POST", { id: first.request.id, operationId: randomUUID() }))
        .status,
    ).toBe(200);
    const recovered = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(recovered.goal?.status).toBe("completed");
    expect(creationDocumentArtifact(recovered.artifact)?.documentId).toBe(documents[0]!.documentId);
    expect(dirname(creationDocumentArtifact(recovered.artifact)!.file!.path)).toBe(join(f.code, "docs"));
    expect(await readFile(creationDocumentArtifact(recovered.artifact)!.file!.path, "utf8")).toContain(
      "Keep the same saved source",
    );
    expect(await f.files.application().queries.detail("project-1", documents[0]!.documentId)).toEqual(saved);
    expect(f.runs()).toBe(1);
    expect((await readdir(recovered.workspaceDirectory!)).filter((name) => name.endsWith(".md"))).toHaveLength(0);
  } finally {
    proceed.resolve();
    await f.close();
  }
}, 60000);
