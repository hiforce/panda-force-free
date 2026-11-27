import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_RECALL_PROOF || ".artifacts/project-memory-natural-recall";
await mkdir(output, { recursive: true });
const question = "你目前对我有多少了解？";
const facts = [
  { key: "user-profile", value: "Lives in Sapporo.", scope: "user" },
  { key: "user-profession", value: "Builds radio telescopes.", scope: "user" },
  { key: "user-food-preferences", value: "Likes yuzu tea.", scope: "user" },
];
const app = await createAppFixture({
  applicationMemory: true,
  completedTurnNotifications: true,
  startupTimeoutMs: 65000,
});
const sessions = "/api/personal/harness/conversations";
let project, otherProject;
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale,
        isMobile: width < 760,
        hasTouch: width < 760,
      });
      await app.signIn(context);
      await context.addInitScript((lang) => {
        localStorage.setItem("panda-force-locale", lang);
        localStorage.setItem("panda-force-theme", "aurora");
      }, locale);
      const call = async (path, method = "GET", data) => {
        const response = await context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const create = async (projectId, memoryPrivate = false) =>
        (
          await call(sessions, "POST", {
            projectId,
            runtimeId: "codex",
            memoryPrivate,
            ...(projectId ? {} : { cwd: join(app.dir, "alpha") }),
          })
        ).conversation;
      const run = async (id, text) => {
        const path = sessions + "/" + id;
        const { runId } = await call(path + "/runs", "POST", { text, requestId: crypto.randomUUID() });
        return waitFor(async () => {
          const details = await call(path);
          return (
            details.run?.id === runId &&
            details.run.status === "complete" &&
            details.messages.some(
              ({ role, status, runId: messageRun }) =>
                role === "assistant" && status === "complete" && messageRun === runId,
            ) &&
            details
          );
        }, 60000);
      };
      if (!project) {
        const addProject = async (name, code) => {
          const { revision } = await call("/api/projects");
          const catalog = await call("/api/projects", "POST", {
            name,
            code,
            revision,
            operationId: crypto.randomUUID(),
          });
          const created = catalog.projects.find((item) => item.code === code);
          await call("/api/projects/" + created.id + "/memory-policy", "PATCH", {
            revision: 0,
            write: true,
            recall: true,
            model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
          });
          return created;
        };
        project = await addProject("Radio lab", "radio-lab");
        otherProject = await addProject("Other lab", "other-lab");
        const { revision } = await call("/api/projects");
        await call("/api/projects/assign", "POST", { revision, projectId: project.id, sessionIds: ["old-alpha"] });
        await call("/api/personal/harness/legacy-memory/old-alpha", "POST", {
          entries: [...facts, { key: "build-timeout", value: "37 minutes", scope: "project" }],
        });
        const source = await create(project.id);
        await run(source.id, "Confirmed: my hobby is collecting meteorite maps.");
        await waitFor(async () => {
          const { entries } = await call("/api/projects/" + project.id + "/memory");
          return entries.some(({ key, scope }) => key === "user-hobby-meteorite-maps" && scope === "project");
        }, 60000);
      }

      const page = await context.newPage();
      for (const memoryPrivate of [false, true]) {
        const target = await create(project.id, memoryPrivate);
        const result = await run(target.id, question);
        const answer = result.messages.find(({ role }) => role === "assistant").text;
        for (const { value } of facts) assert(answer.includes(value), answer);
        if (locale === "zh-CN") assert(answer.includes("Collects meteorite maps."));
        assert(!answer.includes("37 minutes"));
        if (memoryPrivate) {
          assert.equal(result.conversation.memoryPrivate, true);
        } else {
          const memory = await call(sessions + "/" + target.id + "/memory");
          assert.equal(memory.recalls[0].status, "sent");
          assert.equal(memory.recalls[0].references.length, locale === "zh-CN" ? 4 : 5);
        }
        await page.goto(app.base + "/task/harness:" + target.id);
        await page.getByText(answer, { exact: true }).waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const screenshot = locale + "-" + width + (memoryPrivate ? "-private" : "") + ".png";
        await page.screenshot({ path: join(output, screenshot) });

        if (memoryPrivate) {
          const [before, after, repository, values, followUp] =
            locale === "zh-CN"
              ? [
                  "My hobby is restoring wooden telescopes.",
                  "I draw star charts with fountain pens.",
                  "I created Orbit, an open-source tool: https://github.com/example/orbit.",
                  [
                    "Restores wooden telescopes.",
                    "Draws star charts with fountain pens.",
                    "Created Orbit, an open-source tool (https://github.com/example/orbit).",
                  ],
                  "还有没有补充？",
                ]
              : [
                  "My hobby is making paper globes.",
                  "I draw star charts with charcoal.",
                  "I maintain Meridian, an open-source tool: https://github.com/example/meridian.",
                  [
                    "Makes paper globes.",
                    "Draws star charts with charcoal.",
                    "Maintains Meridian, an open-source tool (https://github.com/example/meridian).",
                  ],
                  "還有沒有補充？",
                ];
          const source = await create(project.id);
          const url = "https://example.test/fixture";
          await run(source.id, before + " " + url + " " + after + " " + repository);
          await waitFor(async () => {
            const { entries } = await call("/api/projects/" + project.id + "/memory");
            return values.every((value) =>
              entries.some(
                (entry) =>
                  entry.value === value && entry.sources.some(({ conversationId }) => conversationId === source.id),
              ),
            );
          }, 60000);
          const result = await run(target.id, followUp);
          const reply = result.messages.findLast(({ role }) => role === "assistant").text;
          for (const value of values) assert(reply.includes(value), reply);
          assert(!reply.includes(url));
          assert(!reply.includes("37 minutes"));
          await page.getByText(reply, { exact: true }).waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(output, locale + "-" + width + "-updated-recall.png") });
        }
      }

      const disabled = await create(project.id);
      await call(sessions + "/" + disabled.id + "/memory-policy", "PATCH", { revision: 0, recall: false });
      const projectPolicy = "/api/projects/" + project.id + "/memory-policy";
      const { revision, write, model } = await call(projectPolicy);
      const updated = await call(projectPolicy, "PATCH", { revision, write, model, recall: false });
      const blockedTargets = [await create(otherProject.id, true), await create(undefined, true)];
      for (const blocked of [...blockedTargets, await create(project.id, true)]) {
        const response = await run(blocked.id, question);
        assert.equal(
          response.messages.find(({ role }) => role === "assistant").text,
          "No project memories were provided.",
        );
      }
      await call(projectPolicy, "PATCH", { revision: updated.revision, write, model, recall: true });
      const disabledResult = await run(disabled.id, question);
      assert.equal(
        disabledResult.messages.find(({ role }) => role === "assistant").text,
        "No project memories were provided.",
      );
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Natural recall reached standard and private conversations on PC and H5. Other projects, unlinked sessions and disabled recall stayed fenced.",
  );
} finally {
  await app.dispose();
}
