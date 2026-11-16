import { CreationSubmission } from "../../src/client/creation/submission.js";
import { CreationDrafts } from "../../src/client/creation/drafts.js";
import { creationApi } from "../../src/client/creation/api.js";
import type { CreationTaskView, CreationRequest } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import { restoreCreationDraft, selectCreationSkill, type CreationDraft } from "../../src/client/creation/drafts.js";
import type { CreationSkillSelection } from "../../src/shared/creation/contracts.js";
const base: CreationSkillSelection = {
  packageId: "panda-force.document-creation",
  version: "1.0.0",
  digest: "a".repeat(64),
  id: "writing",
  parameters: {},
};
const chosen: CreationSkillSelection = {
  packageId: "example.writing-kit",
  version: "1.0.0",
  digest: "b".repeat(64),
  id: "brand-voice",
  parameters: { audience: "Developers" },
};
const draft = (): CreationDraft => ({
  prompt: "Keep my brief",
  profileId: "codex",
  parentId: null,
  selections: [base, chosen],
  pending: null,
});
test("legacy draft recovery removes only the injected application workflow and preserves user inputs", () => {
  const original = draft(),
    restored = restoreCreationDraft(original);
  expect(restored.selections).toEqual([chosen]);
  expect(restored.prompt).toBe(original.prompt);
  expect(restored.skillsVersion).toBe(2);
  expect(original.selections).toEqual([base, chosen]);
  expect(restoreCreationDraft(restored)).toEqual(restored);
});
test("explicit selections including a deliberately selected workflow remain unchanged", () => {
  const original = { ...draft(), skillsVersion: 2 as const };
  expect(restoreCreationDraft(original)).toEqual(original);
  expect(restoreCreationDraft({ ...original, selections: [] }).selections).toEqual([]);
});
test("an uncertain legacy submission keeps its exact selections and request until confirmation", () => {
  const original = draft();
  original.pending = {
    id: crypto.randomUUID(),
    projectId: "personal",
    treeVersion: 0,
    parentId: null,
    locale: "en",
    prompt: original.prompt,
    profileId: "codex",
    selections: original.selections,
  };
  expect(restoreCreationDraft(original)).toEqual(original);
  const confirmed = restoreCreationDraft({ ...original, pending: null });
  expect(confirmed.selections).toEqual([chosen]);
});

test("an explicit gallery choice uses that exact version while keeping same-version parameter edits", () => {
  expect(selectCreationSkill([chosen], { ...chosen, parameters: {} })).toEqual([chosen]);
  const newer = { ...chosen, version: "1.1.0", digest: "c".repeat(64), parameters: {} };
  expect(selectCreationSkill([chosen], newer)).toEqual([newer]);
  expect(selectCreationSkill([], newer)).toEqual([newer]);
});

test("uncertain submissions keep their skill choices and only acknowledgement prepares a fresh empty selection", async () => {
  const state: CreationDraft = { ...draft(), selections: [chosen], skillsVersion: 2 },
    store = new CreationDrafts("fixture", crypto.randomUUID());
  const requests: CreationRequest[] = [];
  let acknowledged = false;
  const api = {
    ...creationApi,
    submit: async (request: CreationRequest) => {
      requests.push(structuredClone(request));
      if (!acknowledged) throw Error("Uncertain transport");
      return { task: { id: request.id } as CreationTaskView };
    },
    detail: async () => {
      throw Error("Still unavailable");
    },
  };
  const submission = new CreationSubmission(state, store, api);
  const intent: CreationRequest = {
    id: crypto.randomUUID(),
    projectId: "personal",
    prompt: state.prompt,
    profileId: "codex",
    treeVersion: 0,
    parentId: null,
    locale: "en",
    selections: structuredClone(state.selections),
  };
  await expect(submission.send(() => intent)).rejects.toThrow("Uncertain transport");
  expect(state.selections).toEqual([chosen]);
  expect(store.load()?.pending).toEqual(intent);
  acknowledged = true;
  await submission.send(() => {
    throw Error("Must retry the existing request");
  });
  expect(requests).toEqual([intent, intent]);
  expect(state.selections).toEqual([]);
  expect(state.prompt).toBe("");
  expect(store.load()?.selections).toEqual([]);
});
