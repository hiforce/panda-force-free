import { creationRunInput } from "../../src/server/creation/run-input.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSkillFeature } from "../../src/server/skills/integration/feature.js";
import { FileCreationInputs } from "../../src/server/creation/integration/input-codec.js";
import { decodeSkillCapture } from "../../src/shared/skills/capture-codec.js";
import { creationTaskSpec } from "../../src/server/creation/validation.js";
import { SKILL_CAPABILITIES } from "../../src/shared/skills/contracts.js";

test("planning and empty guidance captures persist across restart without rewriting installed packages or legacy snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-guidance-")),
    owner = "operator",
    stateRoot = join(root, "skills"),
    inputs = new FileCreationInputs(join(root, "inputs"));
  let skills = await createSkillFeature({ stateRoot, version: "0.0.21", owner: () => owner });
  try {
    const original = (await skills.catalog.detail("panda-force.essentials", "1.0.0")).package,
      selected = {
        packageId: original.id,
        version: original.version,
        digest: original.digest,
        id: "science-illustration",
        parameters: {},
      },
      authority = {
        outputType: "image" as const,
        available: new Set(SKILL_CAPABILITIES),
        granted: new Set(SKILL_CAPABILITIES),
        entitled: new Set<string>(),
        guidanceOnly: true,
      },
      id = randomUUID(),
      request = { id, requestBinding: "a".repeat(64), selections: [selected] },
      capture = await skills.catalog.capture(request, owner, authority);
    expect(capture.composition.mode).toBe("guidance");
    expect(capture.composition.skills).toHaveLength(1);
    expect(capture.composition.skills[0]!.id).toBe(selected.id);
    expect(capture.composition.capabilities).toEqual([]);
    expect(decodeSkillCapture(capture)).toEqual(capture);
    const frozen = {
        schema: 1 as const,
        taskId: id,
        owner,
        projectId: "project",
        requestDigest: request.requestBinding,
        prompt: "Generate the finished illustration",
        outputType: "image" as const,
        profile: { id: "default", engineId: "codex" },
        skills: capture,
      },
      digest = await inputs.put(frozen),
      spec = creationTaskSpec({
        schema: 1,
        id,
        owner,
        projectId: "project",
        operationId: randomUUID(),
        kind: "image",
        target: { parentId: null, treeVersion: 0, locale: "en" },
        inputDigest: digest,
        skillCaptureId: id,
      });
    expect((await inputs.read(spec)).skills).toEqual(capture);
    const run = creationRunInput(await inputs.read(spec));
    expect(run.instructions).not.toContain(capture.composition.skills[0]!.instructions);
    expect(run.instructions).toContain("panda_creation_context");
    expect(run.instructions).not.toContain("can save editable documents only");
    expect(run.instructions).toContain("final artifact type: image");
    await expect(inputs.put({ ...frozen, outputType: undefined })).rejects.toThrow("invalidInput");
    const workflow = (await skills.catalog.detail("panda-force.document-creation", "1.0.0")).package,
      legacyId = randomUUID(),
      legacyBinding = "e".repeat(64),
      legacyCapture = await skills.catalog.capture(
        {
          id: legacyId,
          requestBinding: legacyBinding,
          selections: [
            {
              packageId: workflow.id,
              version: workflow.version,
              digest: workflow.digest,
              id: "writing",
              parameters: {},
            },
          ],
        },
        owner,
        { ...authority, outputType: "document", guidanceOnly: false },
      );
    await expect(
      inputs.put({ ...frozen, taskId: legacyId, requestDigest: legacyBinding, skills: legacyCapture }),
    ).rejects.toThrow("invalidInput");
    skills.close();
    skills = await createSkillFeature({ stateRoot, version: "0.0.21", owner: () => owner });
    expect(await skills.catalog.capture(request, owner, authority)).toEqual(capture);
    expect((await skills.catalog.detail(original.id, original.version)).package).toEqual(original);
    await expect(
      skills.catalog.capture(request, owner, { ...authority, guidanceOnly: false, workflowRequired: false }),
    ).rejects.toThrow("operationConflict");
    const empty = await skills.catalog.capture(
      { id: randomUUID(), requestBinding: "b".repeat(64), selections: [] },
      owner,
      authority,
    );
    expect(empty.composition.skills).toEqual([]);
    expect(empty.origins).toEqual([]);
    expect(decodeSkillCapture(empty)).toEqual(empty);
    await expect(
      skills.catalog.capture({ id: randomUUID(), requestBinding: "c".repeat(64), selections: [] }, owner, {
        ...authority,
        guidanceOnly: false,
        workflowRequired: false,
      }),
    ).rejects.toThrow("invalidInput");
  } finally {
    skills.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit output tasks read installed guidance as task data before saving through real HTTP", async () => {
  const { creationAppFixture } = await import("../support/creation-app.js"),
    f = await creationAppFixture();
  try {
    const pack = (await f.files.call("/api/skill-packs/detail?id=panda-force.essentials&version=1.0.0")).body.package;
    let observed = false;
    f.onRun(async (input, callbacks, scope) => {
      expect(input.instructions).not.toContain("panda-force.document-creation/writing@1.0.0");
      expect(input.instructions).not.toContain("panda-force.essentials/software-prd@1.0.0");
      const early = await f.save(callbacks, scope);
      expect(early.success).toBe(false);
      expect(early.text).toContain("contextChanged");
      expect((await f.files.application().navigation.tree("project-1")).nodes).toEqual([]);
      const context = await callbacks.call({
        ...scope,
        callId: randomUUID(),
        name: "panda_creation_context",
        arguments: {},
      });
      const body = JSON.parse(context.text);
      expect(body.requestedOutputType).toBe("document");
      expect(body.latestSkillGuidance[0].id).toBe("panda-force.essentials/software-prd");
      expect(body.latestSkillGuidance[0].instructions).toBeTruthy();
      expect((await f.save(callbacks, scope)).success).toBe(true);
      observed = true;
    });
    const request = {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      locale: "en",
      prompt: "Write the requested factual document",
      profileId: "codex",
      outputType: "document",
      selections: [
        { packageId: pack.id, version: pack.version, digest: pack.digest, id: "software-prd", parameters: {} },
      ],
    };
    expect((await f.files.call("/api/document-creations", "POST", request)).status).toBe(202);
    expect((await f.until(request.id, (task) => task.state === "succeeded" || !!task.failure)).state).toBe("succeeded");
    expect(observed).toBe(true);
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
