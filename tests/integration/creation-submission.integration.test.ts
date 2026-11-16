import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { CreationSubmissions, type CreationSubmissionAuthority } from "../../src/server/creation/submissions.js";
import { FileCreationInputs } from "../../src/server/creation/integration/input-codec.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import { CreationOutputs } from "../../src/server/creation/outputs.js";
import { creationRunInput } from "../../src/server/creation/run-input.js";
import type { CreationRequest } from "../../src/server/creation/input.js";
import { createSkillFeature } from "../../src/server/skills/integration/feature.js";
import { SKILL_CAPABILITIES } from "../../src/shared/skills/contracts.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

const owner = "operator:test-user",
  capabilities = new Set(SKILL_CAPABILITIES.filter((item) => item.startsWith("project.documents.")));
async function fixture() {
  const files = await projectFileApiFixture(),
    stateRoot = join(files.assetRoot, "skills"),
    databasePath = join(files.assetRoot, "creation.sqlite"),
    inputRoot = join(files.assetRoot, "inputs"),
    inputs = new FileCreationInputs(inputRoot);
  let skills = await createSkillFeature({ stateRoot, version: "0.0.18", owner: () => owner }),
    db = openCreationDatabase(databasePath),
    tasks = new CreationTaskRepository(db),
    profile = { id: "default", engineId: "codex", model: "original-model" },
    profileReads = 0;
  const source = await nativeSkillPackage(),
    origin = { kind: "upload", name: "writing-kit.zip", sha256: source.pack.digest },
    review = await skills.catalog.review(source.pack, origin, ["blog-outline", "brand-voice"]);
  await skills.catalog.install(
    source.pack,
    origin,
    {
      id: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      selected: review.selected,
      capabilities: review.capabilities,
    },
    owner,
  );
  const builtin = (await skills.catalog.detail("panda-force.writing", "1.0.0")).package!,
    parent = await files.application().navigation.create(owner, {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      title: "Parent",
      locale: "en",
    });
  const authority: CreationSubmissionAuthority = {
    async authorize(_actor, projectId) {
      if (!files.grants.has(projectId)) throw new Error("Project unavailable");
    },
    async target(_actor, request) {
      const tree = await files.application().navigation.tree(request.projectId);
      if (
        tree.version !== request.treeVersion ||
        (request.parentId !== null && !tree.nodes.some((node) => node.documentId === request.parentId))
      )
        throw new Error("Target changed");
    },
    async profile(id) {
      profileReads++;
      if (id !== profile.id) throw new Error("Profile unavailable");
      return profile;
    },
    capture(actor, request, requestDigest) {
      return skills.catalog.capture(
        { id: request.id, requestBinding: requestDigest, selections: request.selections },
        actor,
        { outputType: "document", available: capabilities, granted: capabilities, entitled: new Set() },
      );
    },
  };
  const request: CreationRequest = {
    id: randomUUID(),
    projectId: "project-1",
    treeVersion: parent.tree.version,
    parentId: parent.operation.documentId,
    locale: "en",
    profileId: "default",
    prompt: "Write a clear article about useful documents.",
    selections: [
      { packageId: builtin.id, version: builtin.version, digest: builtin.digest, id: "writing", parameters: {} },
      ...["blog-outline", "brand-voice"].map((id) => {
        const parameters: Record<string, string> = {};
        if (id === "blog-outline") parameters.audience = "Developers";
        return {
          packageId: source.pack.manifest.id,
          version: source.pack.manifest.version,
          digest: source.pack.digest,
          id,
          parameters,
        };
      }),
    ],
  };
  const service = () => new CreationSubmissions(tasks, inputs, authority);
  return {
    ...files,
    inputRoot,
    inputs,
    authority,
    request,
    service,
    tasks: () => tasks,
    skills: () => skills,
    database: () => db,
    profileReads: () => profileReads,
    changeProfile() {
      profile = { ...profile, model: "a-different-model" };
    },
    async restart() {
      skills.close();
      db.close();
      files.reopen();
      skills = await createSkillFeature({ stateRoot, version: "0.0.18", owner: () => owner });
      db = openCreationDatabase(databasePath);
      tasks = new CreationTaskRepository(db);
    },
    async close() {
      skills.close();
      db.close();
      await files.close();
    },
  };
}

test("submission freezes prompt, selected versions, ordered instructions and parameter values in a private file", async () => {
  const f = await fixture();
  try {
    const task = await f.service().submit(owner, f.request),
      input = await f.inputs.read(task.spec),
      execution = creationRunInput(input);
    expect(input.skills.composition.skills.map((skill) => skill.role)).toEqual(["workflow", "template", "style"]);
    expect(input.skills.composition.skills[1]!.parameters).toEqual({ audience: "Developers" });
    expect(execution.instructions.indexOf("panda-force.writing/writing")).toBeLessThan(
      execution.instructions.indexOf("example.writing-kit/blog-outline"),
    );
    expect(execution.instructions).toContain('Parameters: {"audience":"Developers"}');
    expect(execution.prompt).toBe(f.request.prompt);
    expect(JSON.stringify(f.database().query("SELECT * FROM creation_tasks").get())).not.toContain(f.request.prompt);
    f.changeProfile();
    const current = await f.skills().catalog.detail("example.writing-kit", "1.0.0");
    await f
      .skills()
      .catalog.remove(
        { operationId: randomUUID(), id: "example.writing-kit", version: "1.0.0", expectedRevision: current.revision },
        owner,
      );
    await f.restart();
    const replay = await f.service().submit(owner, f.request);
    expect(replay.spec).toEqual(task.spec);
    expect(f.profileReads()).toBe(1);
    expect((await f.inputs.read(replay.spec)).profile.model).toBe("original-model");
    expect((await f.inputs.read(replay.spec)).skills).toEqual(input.skills);
    await expect(f.service().submit(owner, { ...f.request, prompt: "A different request" })).rejects.toThrow(
      "conflict",
    );
    await expect(f.service().submit("operator:foreign", f.request)).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
}, 30000);

test("two concurrently submitted tasks append under the same logical parent despite intervening manual tree changes", async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.service().submit(owner, f.request),
      f.service().submit(owner, { ...f.request, id: randomUUID() }),
    ]);
    await f.application().navigation.create(owner, {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: f.request.treeVersion,
      parentId: null,
      title: "Concurrent manual document",
      locale: "en",
    });
    const adapter = new FileCreationDocumentOutput(join(f.assetRoot, "outputs"), f.application().navigation, true),
      outputs = new CreationOutputs(f.tasks(), adapter, adapter),
      invoke = async (task: typeof a, label: string) => {
        const lease = f.tasks().claim(owner, task.spec.id, Date.now(), 30000),
          scope = f.tasks().bind(lease, "session-" + label, "run-" + label, Date.now());
        return outputs.invoke(scope, {
          title: label,
          body: richDocumentFromMarkdown("Real generated content " + label),
        });
      },
      [one, two] = await Promise.all([invoke(a, "First generated"), invoke(b, "Second generated")]);
    expect(one.artifact?.documentId).not.toBe(two.artifact?.documentId);
    const tree = await f.application().navigation.tree("project-1");
    expect(tree.nodes).toHaveLength(4);
    for (const result of [one, two])
      expect(tree.nodes.find((node) => node.documentId === result.artifact?.documentId)?.parentId).toBe(
        f.request.parentId,
      );
    const head = await f.snapshots.head();
    await outputs.reconcile(owner, a.spec.id);
    await outputs.reconcile(owner, b.spec.id);
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    await f.close();
  }
}, 30000);

test("request values are detached before asynchronous authorization and revoked access cannot enqueue a late snapshot", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.request);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      authorize = f.authority.authorize;
    f.authority.authorize = async (actor, projectId) => {
      entered();
      await held;
      return authorize(actor, projectId);
    };
    const pending = f.service().submit(owner, f.request);
    await ready;
    f.request.prompt = "Changed outside the submission";
    (f.request.selections[1]!.parameters as Record<string, string>).audience = "Changed";
    release();
    const result = await pending,
      snapshot = await f.inputs.read(result.spec);
    expect(snapshot.prompt).toBe(original.prompt);
    expect(snapshot.skills.composition.skills[1]!.parameters).toEqual({ audience: "Developers" });
    f.authority.authorize = authorize;
    const capture = f.authority.capture;
    f.authority.capture = async (...args) => {
      const value = await capture(...args);
      f.grants.clear();
      return value;
    };
    await expect(f.service().submit(owner, { ...original, id: randomUUID() })).rejects.toThrow("Project unavailable");
    expect(f.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM creation_tasks").get()!.n).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);

test("concurrent retries preserve one input identity and tampered or foreign file references never become engine instructions", async () => {
  const f = await fixture();
  try {
    const [one, two] = await Promise.all([f.service().submit(owner, f.request), f.service().submit(owner, f.request)]);
    expect(one.spec).toEqual(two.spec);
    await expect(f.inputs.read({ ...one.spec, owner: "operator:another" })).rejects.toThrow("unavailable");
    await expect(f.inputs.read({ ...one.spec, projectId: "project-foreign" })).rejects.toThrow("unavailable");
    const path = join(f.inputRoot, one.spec.inputDigest + ".json"),
      bytes = await readFile(path, "utf8");
    await writeFile(path, bytes.replace("Developers", "Tampered!"));
    await expect(f.inputs.read(one.spec)).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 30000);
