import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationBudgetLimits, DEFAULT_GENERATION_BUDGET } from "../../src/shared/knowledge/generation-budget.js";
import { knowledgeProfileSettings } from "../../src/server/knowledge/integration/profiles.js";
test("generation ceilings are administrator-only closed numeric configuration", () => {
  expect(generationBudgetLimits({})).toEqual(DEFAULT_GENERATION_BUDGET);
  expect(generationBudgetLimits({ installationDaily: 2, installationPending: 1 })).toEqual({
    installationDaily: 2,
    ownerDaily: 2,
    installationPending: 1,
    ownerPending: 1,
  });
  for (const value of [
    null,
    [],
    { installationDaily: -1 },
    { ownerDaily: 1.5 },
    { ownerDaily: null },
    { ownerPending: "3" },
    { ownerPending: 33 },
    { installationDaily: 1, ownerDaily: 2 },
    { installationDaily: 100001 },
    { owner: "alice" },
    { endpoint: "https://untrusted.example" },
  ])
    expect(() => generationBudgetLimits(value)).toThrow("invalidInput");
  expect(generationBudgetLimits({ installationDaily: 0, installationPending: 0 })).toEqual({
    installationDaily: 0,
    ownerDaily: 0,
    installationPending: 0,
    ownerPending: 0,
  });
});
test("the mounted knowledge profile can set shared generation budgets without changing the model or rule defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-budget-profile-"));
  try {
    expect(knowledgeProfileSettings(root, {}).generationBudget).toEqual(DEFAULT_GENERATION_BUDGET);
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "config", "knowledge-engines.json"),
      JSON.stringify({
        schema: 1,
        enabled: true,
        id: "work",
        engineId: "codex",
        generationBudget: { installationDaily: 8, ownerDaily: 4, installationPending: 4, ownerPending: 2 },
      }),
    );
    expect(knowledgeProfileSettings(root, {})).toMatchObject({
      id: "work",
      engineId: "codex",
      concurrency: 1,
      generationBudget: { installationDaily: 8, ownerDaily: 4, installationPending: 4, ownerPending: 2 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
