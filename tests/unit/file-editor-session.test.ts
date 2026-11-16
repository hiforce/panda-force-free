import { expect, test } from "bun:test";
import { FileEditorSession } from "../../src/client/documents/files/session.js";
import type { FileEditorApi, FileEditorCommand } from "../../src/client/documents/files/api.js";
import type { FileEditorRecovery, FileRecoveryPort } from "../../src/client/documents/files/recovery.js";
import type { DocumentEditorSnapshot } from "../../src/shared/documents/working-copy.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { DocumentApiError } from "../../src/client/documents/api.js";

function setup() {
  const saved = projectDocumentFixture();
  const snapshot: DocumentEditorSnapshot = {
    saved,
    working: {
      title: saved.revision.title,
      locale: saved.revision.locale,
      content: saved.revision.content,
      resources: [],
    },
    draft: {
      version: 0,
      savedRevisionId: saved.revision.id,
      baseRevisionId: saved.revision.id,
      dirty: false,
      stale: false,
      updatedAt: 1,
    },
  };
  let cache: FileEditorRecovery | null = null;
  const recovery: FileRecoveryPort = {
    read: () => structuredClone(cache),
    write: (value) => {
      cache = structuredClone(value);
    },
  };
  const commands: FileEditorCommand[] = [];
  const api: FileEditorApi = {
    open: async () => structuredClone(snapshot),
    execute: async (command) => {
      commands.push(structuredClone(command));
      if (command.kind === "autosave")
        return {
          operationId: command.input.operationId,
          documentId: saved.document.id,
          version: 1,
          baseRevisionId: saved.revision.id,
          updatedAt: 2,
        };
      return {
        changed: true,
        commit: "commit",
        detail: {
          ...saved,
          document: { ...saved.document, revision: 2, revisionId: "new-revision" },
          revision: { ...saved.revision, ...commands[0]?.input.working, id: "new-revision", number: 2 },
        },
      };
    },
  };
  return { api, recovery, commands, snapshot, cache: () => cache };
}
test("autosave acknowledges a working generation and explicit save alone advances source version", async () => {
  const f = setup(),
    s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Edited" });
  await s.autosave();
  expect(s.unsent).toBe(false);
  expect(s.dirty).toBe(true);
  expect(s.snapshot.saved.document.revision).toBe(1);
  await s.save();
  expect(f.commands.map((c) => c.kind)).toEqual(["autosave", "save"]);
  expect(s.snapshot.saved.document.revision).toBe(2);
  expect(s.dirty).toBe(false);
  expect(f.cache()).toBeNull();
});
test("typing during a delayed autosave is retained and sent with the acknowledged generation", async () => {
  const f = setup(),
    execute = f.api.execute;
  let release!: () => void;
  f.api.execute = async (command) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return execute(command);
  };
  const s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "First" });
  const pending = s.autosave();
  s.update({ ...s.working, title: "Newer typing" });
  release();
  await pending;
  expect(s.working.title).toBe("Newer typing");
  expect(s.unsent).toBe(true);
  expect(f.cache()?.working.title).toBe("Newer typing");
  f.api.execute = execute;
  await s.autosave();
  expect(f.commands[1]?.input.version).toBe(1);
  expect(f.commands[1]?.input.working?.title).toBe("Newer typing");
});
test("an unknown autosave outcome survives reopen and retries the exact request before further changes", async () => {
  const f = setup(),
    execute = f.api.execute;
  f.api.execute = async (command) => {
    f.commands.push(structuredClone(command));
    throw Error("Response lost");
  };
  let s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Recover me" });
  await expect(s.autosave()).rejects.toThrow();
  const frozen = structuredClone(f.commands[0]);
  expect(f.cache()?.pending).toEqual(frozen);
  f.api.execute = execute;
  s = await FileEditorSession.open(f.api, f.recovery, () => {});
  await s.autosave();
  expect(f.commands[1]).toEqual(frozen);
  expect(s.uncertain).toBe(false);
  expect(s.working.title).toBe("Recover me");
});
test("concurrent remote updates preserve local recovery and prevent overwriting the newer generation", async () => {
  const f = setup(),
    s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Local" });
  f.snapshot.draft.version = 9;
  const reopened = await FileEditorSession.open(f.api, f.recovery, () => {});
  expect(reopened.conflict).toBe(true);
  expect(reopened.working.title).toBe("Local");
  await expect(reopened.save()).rejects.toBeInstanceOf(DocumentApiError);
  expect(f.commands).toHaveLength(0);
});
test("storage failures stop mutation before transport", async () => {
  const f = setup(),
    s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Local" });
  f.recovery.write = () => {
    throw Error("Quota");
  };
  await expect(s.autosave()).rejects.toThrow("Quota");
  expect(f.commands).toHaveLength(0);
  expect(s.working.title).toBe("Local");
});

test("a definitive conflict retains editable text until an explicitly requested discard reloads the saved source", async () => {
  const f = setup(),
    execute = f.api.execute;
  f.api.execute = async () => {
    throw new DocumentApiError(409, { messageId: "documents.conflict" });
  };
  const s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Preserve local" });
  await expect(s.autosave()).rejects.toBeInstanceOf(DocumentApiError);
  expect(s.conflict).toBe(true);
  expect(f.cache()?.working.title).toBe("Preserve local");
  f.api.execute = async (command) =>
    command.kind === "discard"
      ? {
          operationId: command.input.operationId,
          documentId: f.snapshot.saved.document.id,
          version: 2,
          baseRevisionId: f.snapshot.saved.revision.id,
          updatedAt: 3,
        }
      : execute(command);
  await s.discard();
  expect(s.conflict).toBe(false);
  expect(s.working.title).toBe(f.snapshot.saved.revision.title);
  expect(s.dirty).toBe(false);
});

test("new typing during a saved-version request remains a recoverable draft on the resulting source version", async () => {
  const f = setup(),
    execute = f.api.execute;
  const s = await FileEditorSession.open(f.api, f.recovery, () => {});
  s.update({ ...s.working, title: "Checkpoint title" });
  await s.autosave();
  let release!: () => void;
  f.api.execute = async (command) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return execute(command);
  };
  const saving = s.save();
  await Promise.resolve();
  s.update({ ...s.working, title: "Typed during checkpoint" });
  release();
  await saving;
  expect(s.snapshot.saved.document.revision).toBe(2);
  expect(s.working.title).toBe("Typed during checkpoint");
  expect(s.unsent).toBe(true);
  expect(f.cache()?.baseRevisionId).toBe("new-revision");
});

test("validation failures can be corrected without falsely entering a concurrency conflict", async () => {
  const f = setup(),
    execute = f.api.execute,
    s = await FileEditorSession.open(f.api, f.recovery, () => {});
  f.api.execute = async () => {
    throw new DocumentApiError(400, { messageId: "documents.invalidInput" });
  };
  s.update({ ...s.working, title: "" });
  await expect(s.autosave()).rejects.toBeInstanceOf(DocumentApiError);
  expect(s.conflict).toBe(false);
  expect(s.uncertain).toBe(false);
  expect(s.unsent).toBe(true);
  f.api.execute = execute;
  s.update({ ...s.working, title: "Corrected title" });
  await s.autosave();
  expect(s.unsent).toBe(false);
  expect(s.working.title).toBe("Corrected title");
});

test("a completed external source edit refreshes a clean session and clears obsolete recovery state", async () => {
  const f = setup(),
    s = await FileEditorSession.open(f.api, f.recovery, () => {}),
    saved = projectDocumentFixture(2, "doc-1", "Reviewed original");
  f.api.open = async () => ({
    saved,
    working: { ...f.snapshot.working, content: saved.revision.content },
    draft: { ...f.snapshot.draft, savedRevisionId: saved.revision.id, baseRevisionId: saved.revision.id },
  });
  await s.refreshSaved(2);
  expect(s.snapshot.saved).toEqual(saved);
  expect(s.working.content).toBe("Reviewed original");
  expect(s.dirty).toBe(false);
  expect(f.cache()).toBeNull();
  await expect(s.refreshSaved(3)).rejects.toMatchObject({ status: 409 });
  expect(s.snapshot.saved).toEqual(saved);
});

test("typing while an applied source version is loading cannot be replaced by its late response", async () => {
  const f = setup(),
    s = await FileEditorSession.open(f.api, f.recovery, () => {});
  let resolve!: (snapshot: DocumentEditorSnapshot) => void;
  f.api.open = () =>
    new Promise<DocumentEditorSnapshot>((done) => {
      resolve = done;
    });
  const pending = s.refreshSaved(2),
    saved = projectDocumentFixture(2, "doc-1", "A remote source edit");
  s.update({ ...s.working, title: "Typed while loading" });
  resolve({
    saved,
    working: { ...f.snapshot.working, content: saved.revision.content },
    draft: { ...f.snapshot.draft, savedRevisionId: saved.revision.id, baseRevisionId: saved.revision.id },
  });
  await expect(pending).rejects.toMatchObject({ status: 409 });
  expect(s.working.title).toBe("Typed while loading");
  expect(f.cache()?.working.title).toBe("Typed while loading");
  expect(s.snapshot.saved.document.revision).toBe(1);
});
