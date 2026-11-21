#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const home = process.env.GROK_HOME;
if (!home) throw Error("Missing isolated fixture home");
const models = {
  currentModelId: "grok-fixture",
  availableModels: [
    {
      modelId: "grok-fixture",
      name: "Grok Fixture",
      _meta: {
        totalContextTokens: 32000,
        defaultReasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    },
  ],
};
let session = null,
  active = null;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (value) => send({ method: "session/update", params: { sessionId: session.id, update: value } });
const sessionPath = (id) => join(home, "sessions", id + ".json");
createInterface({ input: process.stdin }).on(
  "line",
  (line) =>
    void (async () => {
      const frame = JSON.parse(line),
        params = frame.params || {};
      if (!frame.method) {
        if (active?.permission === frame.id) {
          update({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                frame.result?.outcome?.outcome === "selected" ? "Permission acknowledged." : "Permission cancelled.",
            },
          });
          send({ id: active.id, result: { stopReason: "end_turn" } });
          active = null;
        }
        return;
      }
      let result = {};
      if (frame.method === "initialize")
        result = {
          protocolVersion: 1,
          authMethods: [],
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: true } },
          _meta: {
            modelState: {
              currentModelId: "grok-cached-fixture",
              availableModels: [{ modelId: "grok-cached-fixture", name: "Cached Grok Fixture", _meta: {} }],
            },
          },
        };
      else if (["session/new", "session/load"].includes(frame.method)) {
        const account = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
        if (Number.isSafeInteger(account.fixture?.sessionDelayMs))
          await Bun.sleep(Math.min(2000, Math.max(0, account.fixture.sessionDelayMs)));
        if (account.fixture?.rejectSession) {
          send({ id: frame.id, error: { code: -32000, message: "Fixture sign-in required" } });
          return;
        }
        await mkdir(join(home, "sessions"), { recursive: true });
        session =
          frame.method === "session/load"
            ? JSON.parse(await readFile(sessionPath(params.sessionId), "utf8"))
            : { id: randomUUID(), cwd: params.cwd };
        session.yoloMode = params._meta?.yoloMode === true;
        session.application = params._meta?.agentProfile ?? null;
        session.mcpServers = params.mcpServers ?? [];
        await writeFile(sessionPath(session.id), JSON.stringify(session));
        result = { sessionId: session.id, models, _meta: { currentWorkingDirectory: session.cwd } };
      } else if (frame.method === "session/set_config_option") {
        if (typeof params.value !== "string") throw Error("Invalid ACP config value");
        session[params.configId] = params.value;
        result = { configOptions: [] };
      } else if (frame.method === "session/prompt") {
        const account = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
        if (account.fixture?.rejectPrompt) {
          const counter = join(home, "rejected-prompts.txt");
          const previous = await readFile(counter, "utf8").catch(() => "0");
          await writeFile(counter, String(Number(previous) + 1));
          send({ id: frame.id, error: { code: -32000, message: "Fixture prompt authentication failed" } });
          return;
        }
        const text = params.prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const behavior = text.split("Current user message:\n").at(-1);
        active = { id: frame.id };
        if (session.application) {
          if (
            session.application.injectDefaultTools !== false ||
            session.application.agentsMd !== false ||
            session.application.discoverSkills !== false ||
            session.application.toolConfig.tools.some(
              (tool) => !["GrokBuild:search_tool", "GrokBuild:use_tool"].includes(tool.id),
            )
          )
            throw Error("Application tools were not isolated");
          const server = session.mcpServers[0],
            headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
          let sequence = 0;
          const rpc = async (method, params = {}) => {
            const response = await fetch(server.url, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
            });
            const value = await response.json();
            if (value.error) throw Error("Application MCP call failed");
            return value.result;
          };
          await rpc("initialize");
          const { tools } = await rpc("tools/list"),
            names = tools.map((tool) => tool.name);
          const call = (name, args) => rpc("tools/call", { name, arguments: args });
          if (names.includes("panda_editorial_proposal")) {
            const input = JSON.parse(text);
            const first = input.segments[0];
            await call("panda_editorial_proposal", {
              edits: first
                ? [
                    {
                      segmentId: first.id,
                      before: first.text,
                      after: first.text.replace("This are", "This is"),
                      reason: "Grammar correction",
                    },
                  ]
                : [],
            });
          } else if (names.includes("panda_bot_decide")) {
            await call("panda_bot_decide", {
              taskId: JSON.parse(text).taskId,
              decision: "complete",
              reason: `Grok ${session.model} ${session.reasoning_effort} completed the task.`,
            });
          } else if (names.includes("panda_bot_chat_reply")) {
            await call("panda_bot_chat_reply", {
              text: `Grok ${session.model} ${session.reasoning_effort} received: ${text.slice(0, 500)}`,
            });
          } else if (names.includes("panda_documents_create")) {
            await call("panda_creation_context", {});
            await call("panda_documents_create", {
              title: "Grok document",
              body: {
                schema: 1,
                format: "richtext",
                document: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: `Created with ${session.model} ${session.reasoning_effort}.` }],
                    },
                  ],
                },
              },
            });
          }
          update({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Grok ${session.model} ${session.reasoning_effort} finished with scoped application tools.`,
            },
          });
          send({ id: frame.id, result: { stopReason: "end_turn" } });
          active = null;
          return;
        }
        if (behavior.includes("harness.disconnect")) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial saved response." } });
          setTimeout(() => process.exit(17), 250);
          return;
        }
        if (behavior.includes("harness.output-image")) {
          const directory = join(session.cwd, "attachments", "output", "11111111-2222-4333-8444-555555555555"),
            path = join(directory, "中国 历史漫画.png");
          await mkdir(directory, { recursive: true });
          await writeFile(
            path,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWOIbVwMAALAAYLw5TlQAAAAAElFTkSuQmCC",
              "base64",
            ),
          );
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "下载路径：`" + path } });
          await new Promise((resolve) => setTimeout(resolve, 150));
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "`\n\nFixture image completed." },
          });
          send({ id: active.id, result: { stopReason: "end_turn" } });
          active = null;
          return;
        }
        if (behavior.includes("harness.permission")) {
          if (session.yoloMode) {
            update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Fixture native always-approve active." },
            });
            send({ id: active.id, result: { stopReason: "end_turn" } });
            active = null;
            return;
          }
          active.permission = 10;
          send({
            id: active.permission,
            method: "session/request_permission",
            params: {
              sessionId: session.id,
              toolCall: {
                title: behavior.includes("harness.permission-long")
                  ? 'Execute `cp "/var/lib/panda-force/harness/native/' +
                    "long-session-path/".repeat(70) +
                    'history-style-anchor.jpg" "/home/panda/attachments/work/history-style-anchor.jpg" && ls -la` <img src=x onerror="globalThis.__permissionInjected=true">'
                  : "Fixture read-only action",
              },
              options: [
                {
                  optionId: "yes",
                  name: behavior.includes("harness.permission-long") ? "Yes, proceed" : "Allow once",
                  kind: "allow_once",
                },
                {
                  optionId: "no",
                  name: behavior.includes("harness.permission-long")
                    ? "No, and tell Grok what to do differently"
                    : "Deny",
                  kind: "reject_once",
                },
              ],
            },
          });
          return;
        }
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Grok fixture reply" } });
        if (behavior.includes("harness.hold")) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " completed." } });
        result = { stopReason: "end_turn" };
        active = null;
      } else if (frame.method === "session/cancel") {
        if (active) send({ id: active.id, result: { stopReason: "cancelled" } });
        active = null;
        return;
      }
      if (frame.id !== undefined) send({ id: frame.id, result });
    })().catch(() => send({ error: { code: -32603, message: "Fixture error" } })),
);
