import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { legacyHistoryFixture } from "../support/legacy-history-fixture.js";
import { planLegacyProjectCutover } from "../../src/server/content-migration/plan.js";
import { documentStoragePlanCommand } from "../../src/server/content-migration/cli.js";

test("the shipped read-only planning command reports documents and real historical blockers without application startup", async () => {
  const f = await legacyHistoryFixture();
  try {
    const backup = await f.backup(),
      before = await readFile(backup),
      files = await readdir(f.root),
      command = Bun.spawn(
        [
          process.execPath,
          resolve("src/server/content-migration/cli.ts"),
          "plan",
          "--backup",
          backup,
          "--project",
          f.f.space.projectId,
        ],
        {
          env: {
            PATH: process.env.PATH!,
            HOME: f.root,
            CODEX_HOME: resolve(f.root, "unused-engine-home"),
            PANDA_FORCE_HOME: resolve(f.root, "unused-application-home"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const [code, out, error] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
      ]),
      plan = JSON.parse(out);
    expect(code).toBe(2);
    expect(error).toBe("");
    expect(plan.status).toBe("blocked");
    expect(plan.storageActivated).toBe(false);
    expect(plan.historyReconciled).toBe(false);
    expect(plan.originals).toHaveLength(1);
    expect(plan.originals[0].revisions).toBe(3);
    expect(plan.metadata.spaces).toBe(2);
    expect(plan.history.blockers.some((row: { id: string }) => row.id === f.social.plan.id)).toBe(true);
    expect(await readFile(backup)).toEqual(before);
    expect(await readdir(f.root)).toEqual(files);
    expect(f.f.requests).toEqual([]);
    expect(await planLegacyProjectCutover({ backup, projectId: f.f.space.projectId })).toEqual(plan);
  } finally {
    await f.close();
  }
}, 30000);

test("cutover planning captures input once and rejects a changed or invalid backup without initializing content roots", async () => {
  const f = await legacyHistoryFixture();
  try {
    const backup = await f.backup(),
      input = { backup, projectId: f.f.space.projectId },
      pending = planLegacyProjectCutover(input);
    input.backup = "/unreadable/changed.sqlite";
    input.projectId = "foreign";
    expect((await pending).projectId).toBe(f.f.space.projectId);
    await expect(
      planLegacyProjectCutover({ backup: "relative.sqlite", projectId: f.f.space.projectId }),
    ).rejects.toThrow("invalidFile");
    const files = await readdir(f.root);
    let output = "";
    expect(
      await documentStoragePlanCommand(
        ["plan", "--backup", backup, "--project", f.f.space.projectId, "--project", "foreign"],
        (text) => {
          output += text;
        },
      ),
    ).toBe(1);
    expect(JSON.parse(output).storageActivated).toBe(false);
    expect(await readdir(f.root)).toEqual(files);
  } finally {
    await f.close();
  }
}, 30000);

test("storage planner help and argument errors never require an installed application or expose raw errors", async () => {
  let help = "",
    problem = "";
  expect(
    await documentStoragePlanCommand(["--help"], (text) => {
      help += text;
    }),
  ).toBe(0);
  expect(help).toContain("Read-only inventory");
  expect(
    await documentStoragePlanCommand(["activate", "--backup", "/private/value", "--project", "project"], (text) => {
      problem += text;
    }),
  ).toBe(1);
  expect(JSON.parse(problem)).toEqual({ schema: 1, status: "error", code: "invalidFile", storageActivated: false });
  expect(problem).not.toContain("/private/value");
});

test("explicitly cancelled plans remove readiness blockers while keeping their immutable history and source authority", async () => {
  const f = await legacyHistoryFixture();
  try {
    await f.f.feature.service.cancel("owner", "x-post", f.social.plan.id);
    f.sites.cancel("owner", f.plan.id, () => {});
    const backup = await f.backup(),
      before = await readFile(backup);
    let output = "";
    expect(
      await documentStoragePlanCommand(["plan", "--backup", backup, "--project", f.f.space.projectId], (text) => {
        output += text;
      }),
    ).toBe(0);
    const plan = JSON.parse(output);
    expect(plan.status).toBe("inventoried");
    expect(plan.history.blockers).toEqual([]);
    expect(plan.history.records.filter((row: { table: string }) => row.table === "publication_plans")).toHaveLength(2);
    expect(
      plan.history.records.filter((row: { table: string }) => row.table === "publication_cancellations"),
    ).toHaveLength(1);
    expect(plan.storageActivated).toBe(false);
    expect(plan.historyReconciled).toBe(false);
    expect(await readFile(backup)).toEqual(before);
    expect(f.f.requests).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
