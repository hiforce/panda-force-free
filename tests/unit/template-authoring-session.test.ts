import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TemplateDraftDetail, TemplateDraftResult } from "../../src/shared/templates/authoring/contracts.js";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import { DocumentTemplateAuthoring } from "../../src/server/templates/authoring/document.js";
import { createPortableTemplateTypes, templateDocumentCodec } from "../../src/server/templates/integration/types.js";
import {
  TemplateAuthoringSession,
  type TemplateRecoveryValue,
  type TemplateSaveCommand,
  type TemplateRecoveryPort,
} from "../../src/client/templates/authoring/session.js";
import { templateRecoveries } from "../../src/client/templates/authoring/recovery.js";
import { PluginApiError } from "../../src/client/plugins/api.js";

async function detail() {
  const definition = emptyDocumentTemplate("custom.session"),
    template = await new DocumentTemplateAuthoring(createPortableTemplateTypes(), templateDocumentCodec).create(
      definition,
    );
  return {
    definition,
    draft: {
      id: randomUUID(),
      owner: "owner",
      revision: 1,
      digest: template.digest,
      manifest: structuredClone(template.manifest),
      createdAt: 1,
      updatedAt: 1,
      removed: false,
    },
  } satisfies TemplateDraftDetail;
}
function recovery(): TemplateRecoveryPort {
  let value: TemplateRecoveryValue | null = null;
  return {
    read: () => structuredClone(value),
    write: (next) => {
      value = structuredClone(next);
    },
    clear: () => {
      value = null;
    },
  };
}
function response(base: TemplateDraftDetail, command: TemplateSaveCommand): TemplateDraftResult {
  const revision = command.expectedRevision + 1,
    digest = String(revision).repeat(64);
  return {
    acknowledgement: { operationId: command.operationId, id: command.id, revision, digest, removed: false },
    current: { definition: structuredClone(command.definition), draft: { ...base.draft, revision, digest } },
  };
}
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] || null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
test("lost save responses retry the original command after reopening and preserve text typed after submission", async () => {
  let remote = await detail(),
    accepted: TemplateDraftResult | null = null,
    original: TemplateSaveCommand | null = null,
    calls = 0;
  const local = recovery(),
    api = {
      detail: async () => remote,
      async save(command: TemplateSaveCommand) {
        calls++;
        if (!accepted) {
          original = structuredClone(command);
          accepted = response(remote, command);
          remote = accepted.current!;
          throw TypeError("Response lost after commit");
        }
        if (command.operationId === original!.operationId) {
          expect(command).toEqual(original!);
          return accepted;
        }
        expect(command.expectedRevision).toBe(2);
        accepted = response(remote, command);
        remote = accepted.current!;
        return accepted;
      },
    };
  const first = new TemplateAuthoringSession(remote, api, local);
  first.update({ ...first.working, name: { en: "First saved text" } });
  await expect(first.save()).rejects.toThrow("Response lost");
  first.update({ ...first.working, name: { en: "Typed after submit" } });
  first.persist();
  const reopened = new TemplateAuthoringSession(remote, api, local);
  expect(reopened.conflict).toBe(false);
  await reopened.save();
  expect(reopened.saved.draft.revision).toBe(2);
  expect(reopened.working.name.en).toBe("Typed after submit");
  expect(reopened.dirty).toBe(true);
  await reopened.save();
  expect(calls).toBe(3);
  expect(reopened.saved.draft.revision).toBe(3);
  expect(reopened.changed).toBe(false);
  expect(local.read()).toBeNull();
});

test("a late acknowledgement from a closed editor cannot erase the next editor's local recovery", async () => {
  const initial = await detail(),
    disk = storage(),
    recover = templateRecoveries("identity-a", disk),
    firstPort = recover(initial.draft.id);
  let finish!: (value: TemplateDraftResult) => void, sent!: TemplateSaveCommand;
  const api = {
    detail: async () => initial,
    save: (command: TemplateSaveCommand) => {
      sent = command;
      return new Promise<TemplateDraftResult>((resolve) => {
        finish = resolve;
      });
    },
  };
  const first = new TemplateAuthoringSession(initial, api, firstPort);
  first.update({ ...first.working, instructions: "Older editor" });
  const waiting = first.save(),
    secondPort = recover(initial.draft.id),
    second = new TemplateAuthoringSession(initial, api, secondPort);
  second.update({ ...second.working, instructions: "New editor's unsent changes" });
  second.persist();
  finish(response(initial, sent));
  await waiting;
  expect(secondPort.read()!.working.instructions).toBe("New editor's unsent changes");
  expect(first.recoveryFailed).toBe(true);
  const otherIdentity = templateRecoveries("identity-b", disk);
  expect(otherIdentity(initial.draft.id).read()).toBeNull();
});

test("storage quota failures do not prevent an explicit server save or erase further typing", async () => {
  const initial = await detail();
  let sent!: TemplateSaveCommand, finish!: (result: TemplateDraftResult) => void;
  const local: TemplateRecoveryPort = {
    read: () => null,
    write() {
      throw Error("Quota exceeded");
    },
    clear() {},
  };
  const session = new TemplateAuthoringSession(
    initial,
    {
      detail: async () => initial,
      save: (command) => {
        sent = command;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    local,
  );
  session.update({ ...session.working, instructions: "Save this source" });
  const waiting = session.save();
  expect(sent.definition.instructions).toBe("Save this source");
  session.update({ ...session.working, instructions: "New unsaved typing" });
  finish(response(initial, sent));
  await waiting;
  expect(session.saved.definition.instructions).toBe("Save this source");
  expect(session.working.instructions).toBe("New unsaved typing");
  expect(session.recoveryFailed).toBe(true);
  expect(session.dirty).toBe(true);
});

test("conflicts and removals preserve working text; reload cannot discard an uncertain command", async () => {
  const initial = await detail(),
    local = recovery();
  let reads = 0,
    reject = false;
  const session = new TemplateAuthoringSession(
    initial,
    {
      detail: async () => {
        reads++;
        return initial;
      },
      save: async () => {
        if (reject) throw new PluginApiError(409, { messageId: "templates.draftConflict" });
        throw TypeError("Unavailable");
      },
    },
    local,
  );
  session.update({ ...session.working, instructions: "Keep this work" });
  await expect(session.save()).rejects.toThrow("Unavailable");
  await expect(session.reload()).rejects.toThrow("Unavailable");
  expect(reads).toBe(0);
  expect(session.working.instructions).toBe("Keep this work");
  reject = true;
  await expect(session.save()).rejects.toBeInstanceOf(PluginApiError);
  expect(session.conflict).toBe(true);
  expect(local.read()!.working.instructions).toBe("Keep this work");
  await session.reload();
  expect(reads).toBe(1);
  expect(session.conflict).toBe(false);
});
