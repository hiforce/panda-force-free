import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationAppFixture } from "../support/creation-app.js";
for (const withTemplate of [false, true])
  test(
    "document creation accepts " +
      (withTemplate ? "an explicit template without a selected workflow" : "an empty user skill selection"),
    async () => {
      const f = await creationAppFixture();
      try {
        const pack = (await f.files.call("/api/skill-packs/detail?id=panda-force.essentials&version=1.0.0")).body
          .package;
        const selections = withTemplate
          ? [{ packageId: pack.id, version: pack.version, digest: pack.digest, id: "software-prd", parameters: {} }]
          : [];
        const request = {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          locale: "en",
          prompt: "Create a factual document",
          profileId: "codex",
          selections,
        };
        const response = await f.files.call("/api/document-creations", "POST", request);
        expect(response.status).toBe(202);
        const repeated = await f.files.call("/api/document-creations", "POST", request);
        expect(repeated.status).toBe(202);
        expect(repeated.body.task.id).toBe(response.body.task.id);
        await f.until(request.id, (task) => task.state === "succeeded");
        expect(f.runs()).toBe(1);
        expect(f.scopes[0]!.input.instructions).toContain("panda-force.document-creation/writing@1.0.0");
        expect(f.scopes[0]!.input.instructions.includes("panda-force.essentials/software-prd@1.0.0")).toBe(
          withTemplate,
        );
        expect(request.selections).toEqual(selections);
        expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
    60000,
  );
