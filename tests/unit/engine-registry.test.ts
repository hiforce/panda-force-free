import { expect, test } from "bun:test";
import { createEngineRegistry } from "../../src/server/engines/registry.js";
import { createCodexDriver } from "../../src/server/engines/codex.js";
import { createEngineRpc } from "../../src/server/engines/rpc-compat.js";
import type { CodexTransportOptions } from "../../src/server/engines/codex-transport.js";
import type { EngineEvent } from "../../src/shared/engine/contracts.js";
import { engineQuestions, validateQuestionAnswers } from "../../src/shared/engine/questions.js";

function fixture() {
  let callbacks!: CodexTransportOptions;
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const responses: object[] = [];
  const driver = createCodexDriver(
    { connection: { mode: "isolated" }, defaultCwd: "/work", version: "test", isShuttingDown: () => false },
    (options) => {
      callbacks = options;
      return {
        connected: true,
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === "thread/list")
            return { data: [{ id: "one", cwd: "/work", name: "Native title" }], nextCursor: null };
          return {
            thread: {
              id: "one",
              turns: [
                {
                  id: "turn",
                  status: "completed",
                  items: [{ id: "message", type: "agentMessage", text: "Native output" }],
                },
              ],
            },
          };
        },
        sendRaw(message) {
          responses.push(message);
        },
        start() {},
        terminate() {},
        fullyStopped: () => true,
        cancelRestart() {},
        rejectPending() {},
      };
    },
  );
  const events: EngineEvent[] = [];
  driver.subscribe((event) => events.push(event));
  return { driver, requests, responses, callbacks, events };
}

test("canonical session and command interfaces adapt native sessions without changing output text", async () => {
  const { driver, requests } = fixture();
  const list = await driver.sessions.list({ limit: 10 });
  expect(list.sessions[0].id).toBe("one");
  const session = await driver.sessions.read("one");
  expect(session.turns[0].items[0].text).toBe("Native output");
  const rpc = createEngineRpc(driver);
  await rpc("thread/queue/start", { threadId: "one" });
  expect(requests.at(-1)?.method).toBe("thread/queue/start");
  expect(() => rpc("unregistered/method")).toThrow("Unsupported");
});

test("approval choices stay opaque outside the driver and unavailable choices never reach the CLI", () => {
  const { driver, callbacks, events, responses } = fixture();
  callbacks.onMessage({
    id: 5,
    method: "execCommandApproval",
    params: { conversationId: "one", command: ["echo", "hello"] },
  });
  const event = events[0];
  expect(event.kind).toBe("approval");
  if (event.kind !== "approval" || event.envelope.surface?.kind !== "approval")
    throw new Error("Missing approval surface");
  expect(event.envelope.surface.model.primary.decision).toEqual({ choiceId: "primary" });
  expect(() => driver.respond(event.envelope.id, { choiceId: "forged" })).toThrow("unavailable");
  driver.validateResponse(event.envelope.id, { choiceId: "primary" });
  driver.validateResponse(event.envelope.id, { choiceId: "primary" });
  expect(responses).toHaveLength(0);
  driver.respond(event.envelope.id, { choiceId: "primary" });
  expect(responses).toEqual([{ id: 5, result: { decision: "approved" } }]);
});

test("questionnaires normalize identities and validate all answers before forwarding", () => {
  const { driver, callbacks, events, responses } = fixture();
  const questions = [{ id: "__proto__", question: "Choose", options: [{ label: "A" }, { label: "B" }] }];
  callbacks.onMessage({ id: "question", method: "item/tool/requestUserInput", params: { questions } });
  const event = events[0];
  expect(event.kind === "approval" && event.envelope.surface?.kind).toBe("questions");
  if (event.kind !== "approval") throw new Error("Missing questionnaire");
  expect(() => driver.respond(event.envelope.id, { answers: {} })).toThrow("every");
  expect(responses).toHaveLength(0);
  const result = { answers: Object.fromEntries([["__proto__", { answers: ["A"] }]]) };
  driver.respond(event.envelope.id, result);
  expect(responses).toEqual([{ id: "question", result }]);
  expect(() =>
    validateQuestionAnswers(engineQuestions(questions), {
      answers: Object.fromEntries([["__proto__", { answers: ["C"] }]]),
    }),
  ).toThrow("displayed");
});

test("unsupported capabilities are rejected and command tools cannot be selected as conversation engines", async () => {
  const { driver, requests } = fixture();
  const registry = createEngineRegistry();
  registry.register({ ...driver, descriptor: { ...driver.descriptor, capabilities: ["sessions"] } });
  await expect(registry.execute("codex", "input.start")).rejects.toThrow("unavailable");
  expect(requests).toHaveLength(0);
  registry.registerTool({
    descriptor: { id: "spark", name: "Spark CLI", kind: "command-tool" },
    execute: async (arguments_) => ({ stdout: arguments_.join(" "), stderr: "", exitCode: 0 }),
  });
  expect(() => registry.select("spark")).toThrow("not installed");
  expect((await registry.executeTool("spark", ["projects", "list"])).stdout).toBe("projects list");
  expect(() => registry.register(driver)).toThrow("Duplicate");
});
