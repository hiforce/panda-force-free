import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationInteractionTools } from "../../src/server/creation/runtime/interaction-tools.js";
import type { CreationInputSnapshot } from "../../src/server/creation/input.js";
import type { CreationRunTasks } from "../../src/server/creation/runtime/contracts.js";
import type { CreationMessages } from "../../src/server/creation/messages/service.js";
import type { CreationGoalStore } from "../../src/server/creation/goals/contracts.js";

test("large context and escaped message pages stay deliverable and do not release save fences before full reads", async () => {
  const taskId = randomUUID(),
    id = randomUUID(),
    execution = { taskId, owner: "owner", generation: 1, token: "token", sessionId: "session", runId: "run" };
  const prompt = '"\\\n'.repeat(5000),
    instructions = 'Read every requirement. "\\\n'.repeat(5000);
  const input = {
    materials: [],
    skills: { composition: { skills: [{ qualifiedId: "pack/skill", instructions, parameters: {} }] } },
  } as unknown as CreationInputSnapshot;
  const updates = [{ record: { id, taskId }, payload: { prompt, materials: [], skills: input.skills } }];
  const seen: string[][] = [];
  const messages = {
    context: async () => updates,
    seen: async (_lease: unknown, ids: string[]) => {
      seen.push(ids);
    },
  } as unknown as CreationMessages;
  let at = 1;
  const goals = {
    read: () => ({ at, goal: { id: randomUUID(), objective: "Current target", updatedAt: at, status: "active" } }),
  };
  const goalId = randomUUID();
  let objective = "Current target";
  goals.read = () => ({ at, goal: { id: goalId, objective, updatedAt: at, status: "active" } });
  const tools = creationInteractionTools(
    execution,
    input,
    { assertExecution: async () => ({}) } as unknown as CreationRunTasks,
    () => execution,
    messages,
    undefined,
    goals as unknown as CreationGoalStore,
  );
  const call = async (args: Record<string, unknown>) => {
    const response = await tools.call({
      ...execution,
      callId: randomUUID(),
      name: "panda_creation_context",
      arguments: args,
    });
    expect(response.text.length).toBeLessThanOrEqual(32768);
    return JSON.parse(response.text);
  };
  let page = await call({}),
    text = page.text;
  expect(tools.version()).toBeUndefined();
  expect(tools.goalVersion()).toBeUndefined();
  expect(seen.flat()).toEqual([]);
  while (page.nextOffset !== null) {
    page = await call({ contextOffset: page.nextOffset });
    text += page.text;
  }
  expect(JSON.parse(text).latestSkillGuidance[0].instructions).toBe(instructions);
  expect(tools.goalVersion()).toBe(1);
  expect(tools.version()).toBeUndefined();
  let offset: number | null = 280,
    read = prompt.slice(0, 280);
  while (offset !== null) {
    page = await call({ messageId: id, offset });
    read += page.text;
    offset = page.nextOffset;
  }
  expect(read).toBe(prompt);
  expect(tools.version()).toBe(id);
  expect(seen.flat()).toContain(id);
  at = 2;
  objective = '"'.repeat(16000);
  const goalRead = await tools.call({
    ...execution,
    callId: randomUUID(),
    name: "panda_creation_goal",
    arguments: { action: "read" },
  });
  expect(goalRead.text.length).toBeLessThanOrEqual(32768);
  expect(JSON.parse(goalRead.text).goalId).toBe(goalId);
  page = await call({});
  expect(page.nextOffset).not.toBeNull();
  expect(tools.goalVersion()).toBe(1);
});
