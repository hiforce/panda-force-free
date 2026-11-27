import { defaultCreationOutput } from "../../src/shared/creation/default-output.js";
import { creationCaptureCapabilities } from "../../src/server/creation/integration/capabilities.js";
import { creationImageTools, RENDER_IMAGE_TOOL } from "../../src/server/creation/integration/image-tools.js";
import { ImageRenderJournal } from "../../src/server/creation/integration/rendering/image-journal.js";
import { ImageRenderError } from "../../src/server/creation/integration/rendering/image-contracts.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { creationRequest, creationRequestDigest } from "../../src/server/creation/requests.js";
import { creationArtifact, creationTaskSpec } from "../../src/server/creation/validation.js";
import { assertCreationOutput } from "../../src/server/creation/output-type.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { creationStateMessage } from "../../src/client/creation/state.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";
import type { CreationTaskView } from "../../src/shared/creation/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const request = () => ({
  id: randomUUID(),
  projectId: "project",
  treeVersion: 0,
  parentId: null,
  locale: "en",
  prompt: "Create a finished illustration",
  profileId: "default",
  selections: [],
});
const task = (kind: CreationTaskSpec["kind"] = "document") =>
  creationTaskSpec({
    schema: 1,
    id: randomUUID(),
    owner: "operator",
    projectId: "project",
    operationId: randomUUID(),
    kind,
    target: { parentId: null, treeVersion: 0, locale: "en" },
    inputDigest: "a".repeat(64),
    skillCaptureId: null,
  });
const asset = (spec: CreationTaskSpec) => ({
  kind: "image" as const,
  projectId: spec.projectId,
  operationId: spec.operationId,
  assetId: "c-" + spec.operationId,
  version: "b".repeat(64),
  commit: "c".repeat(40),
  title: "Illustration",
  source: { name: "illustration.png", digest: "d".repeat(64), size: 123 },
});

test("legacy requests preserve their absent output field and digest; explicit output choices remain immutable", () => {
  const legacy = request(),
    parsed = creationRequest(legacy);
  expect(parsed).toEqual(legacy);
  expect(Object.hasOwn(parsed, "outputType")).toBe(false);
  expect(creationRequestDigest(parsed)).toBe(creationRequestDigest(legacy));
  for (const outputType of ["auto", "document", "image", "slides", "video", "web"] as const) {
    const next = creationRequest({ ...legacy, outputType });
    expect(next.outputType).toBe(outputType);
    expect(creationRequestDigest(next)).not.toBe(creationRequestDigest(parsed));
  }
  for (const outputType of [null, "file", "script", {}, 1])
    expect(() => creationRequest({ ...legacy, outputType })).toThrow("invalidInput");
});

test("real asset receipts have their own identity and cannot impersonate a document, project or operation", () => {
  const spec = task("image"),
    receipt = asset(spec);
  expect(creationArtifact(receipt, spec)).toEqual(receipt);
  for (const patch of [
    { kind: "video" },
    { projectId: "other" },
    { assetId: "c-" + randomUUID() },
    { operationId: randomUUID() },
    { documentId: "borrowed-document" },
    { treeVersion: 1 },
    { version: "bad" },
    { source: { ...receipt.source, name: "../private.png" } },
    { source: { ...receipt.source, size: 0 } },
  ])
    expect(() => creationArtifact({ ...receipt, ...patch }, spec)).toThrow();
  expect(() => creationArtifact(receipt, task("document"))).toThrow();
  const auto = { ...spec, kind: "auto" as const };
  expect(creationArtifact(receipt, auto).kind).toBe("image");
  for (const kind of ["slides", "video", "web"] as const)
    expect(creationArtifact({ ...receipt, kind }, { ...spec, kind }).kind).toBe(kind);
});

test("a saved media override cannot reroute another Harness to the primary Codex renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-image-harness-"));
  directories.push(root);
  const spec = task("image"),
    scope = { owner: spec.owner, taskId: spec.id, token: "lease", generation: 1, sessionId: "session", runId: "run" },
    { owner, projectId } = spec,
    renderModels: (string | undefined)[] = [];
  const renderer = creationImageTools({
    journal: new ImageRenderJournal(root),
    assets: async () => {
      throw Error("Unexpected asset access");
    },
    tasks: {
      get() {
        throw Error("Unexpected task access");
      },
    },
    outputs: {
      async invoke() {
        throw Error("Unexpected output");
      },
    },
    available: async () => true,
    renderer: {
      async render(input) {
        renderModels.push(input.profile.model);
        throw new ImageRenderError("unavailable");
      },
    },
  });
  const open = (engineId: string, runtimeId: string | undefined, model = "selected-model") =>
    renderer.open({
      task: spec,
      input: {
        schema: 1,
        taskId: spec.id,
        owner,
        projectId,
        requestDigest: spec.inputDigest,
        prompt: "Draw a circle",
        profile: {
          id: "default",
          engineId,
          ...(runtimeId ? { runtimeId } : {}),
          model,
          media: { model: "codex-image-model" },
        },
        skills: {
          id: spec.id,
          owner,
          requestBinding: spec.inputDigest,
          registryRevision: 1,
          createdAt: 0,
          origins: [],
          composition: { schema: 1, outputType: "image", skills: [], capabilities: [], constraints: {} },
        },
      },
      signal: new AbortController().signal,
      execution: () => scope,
      active: async () => {},
      assert: async () => scope,
    });
  const render = {
    sessionId: "session",
    runId: "run",
    callId: "call",
    name: RENDER_IMAGE_TOOL,
    arguments: { slot: 1, prompt: "Draw a circle" },
  };
  const foreign = await open("harness-zcode", "zcode");
  expect(foreign.definitions.some(({ name }) => name === RENDER_IMAGE_TOOL)).toBe(false);
  expect(await foreign.call(render)).toMatchObject({ success: false });
  const namedCodex = await open("harness-other-codex", "other-codex");
  expect(namedCodex.definitions.some(({ name }) => name === RENDER_IMAGE_TOOL)).toBe(false);
  expect(await namedCodex.call(render)).toMatchObject({ success: false });
  expect(renderModels).toEqual([]);

  for (const runtimeId of ["codex", undefined]) {
    const primary = await open("codex", runtimeId);
    expect(primary.definitions.some(({ name }) => name === RENDER_IMAGE_TOOL)).toBe(true);
    await primary.call(render);
  }
  expect(renderModels).toEqual(["codex-image-model", "codex-image-model"]);
});

test("an explicit image request rejects a document before staging or project writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-output-type-"));
  directories.push(root);
  let writes = 0;
  const source = {
      createFromSource: async () => {
        writes++;
        throw Error("No project mutation may be called");
      },
    },
    adapter = new FileCreationDocumentOutput(join(root, "outputs"), source),
    spec = task("image"),
    body = { title: "Wrong deliverable", body: richDocumentFromMarkdown("A design brief is not an image.") };
  await expect(adapter.stage(body, spec)).rejects.toThrow("invalidOutput");
  await expect(stat(join(root, "outputs"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(writes).toBe(0);
  await expect(adapter.commit(spec, "a".repeat(64))).rejects.toThrow("writeUnavailable");
  expect(writes).toBe(0);
  for (const kind of ["slides", "video", "web"] as const) {
    await expect(adapter.stage(body, task(kind))).rejects.toThrow("invalidOutput");
    expect(writes).toBe(0);
  }
  expect(() => assertCreationOutput(spec, "document")).toThrow("invalidOutput");
  expect(() => assertCreationOutput({ ...spec, kind: "auto" }, "image")).not.toThrow();
});

test("completed assets use a generic saved status and retain document-specific behavior for existing tasks", () => {
  const spec = task("image"),
    artifact = creationArtifact(asset(spec), spec),
    view = {
      id: spec.id,
      projectId: spec.projectId,
      state: "succeeded",
      generation: 0,
      prompt: "image",
      model: null,
      cancelRequested: false,
      artifact,
      failure: null,
      question: null,
      createdAt: 1,
      updatedAt: 1,
    } satisfies CreationTaskView;
  expect(creationStateMessage(view)).toBe("creative.saved");
  expect(creationStateMessage({ ...view, artifact: null })).toBe("creation.succeeded");
  expect(creationStateMessage({ ...view, state: "running" })).toBe("creation.running");
  expect(creationStateMessage({ ...view, failure: "invalidOutput" })).toBe("creation.failed");
});

test("typed asset completion is transactional and survives a SQLite ledger restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-typed-ledger-"));
  directories.push(root);
  const path = join(root, "ledger.sqlite");
  let db = openCreationDatabase(path);
  try {
    for (const kind of ["image", "slides", "video", "web"] as const) {
      const spec = task(kind),
        tasks = new CreationTaskRepository(db),
        receipt = { ...asset(spec), kind };
      tasks.create(spec, 1);
      const scope = tasks.bind(tasks.claim(spec.owner, spec.id, 2, 30000), "owned-session", "owned-run", 3);
      tasks.admit(scope, "f".repeat(64), 4);
      expect(() =>
        tasks.complete(
          spec.owner,
          spec.id,
          "f".repeat(64),
          {
            kind: "document",
            projectId: spec.projectId,
            operationId: spec.operationId,
            documentId: "wrong-document",
            treeVersion: 1,
          },
          5,
        ),
      ).toThrow();
      expect(tasks.get(spec.owner, spec.id).state).toBe("committing");
      expect(tasks.complete(spec.owner, spec.id, "f".repeat(64), receipt, 5).artifact).toEqual(receipt);
      db.close();
      db = openCreationDatabase(path);
      expect(new CreationTaskRepository(db).get(spec.owner, spec.id).artifact).toEqual(receipt);
      expect(Object.hasOwn(new CreationTaskRepository(db).get(spec.owner, spec.id).artifact!, "documentId")).toBe(
        false,
      );
    }
  } finally {
    db.close();
  }
});

test("new output defaults and skill grants follow connected renderers without changing legacy requests", () => {
  expect(defaultCreationOutput({})).toBe("document");
  expect(defaultCreationOutput({ outputTypes: ["document"] })).toBe("auto");
  expect(defaultCreationOutput({ outputTypes: ["document", "image"] })).toBe("auto");
  expect(creationCaptureCapabilities(undefined, ["image"])).toEqual(["project.documents.create"]);
  expect(creationCaptureCapabilities("image", ["image"])).toContain("generate.image");
  expect(creationCaptureCapabilities("auto", [])).not.toContain("generate.image");
});
