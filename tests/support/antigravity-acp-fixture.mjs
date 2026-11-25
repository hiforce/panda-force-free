#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const claude = Boolean(process.env.CLAUDE_CODE_EXECUTABLE);
if (!process.env.HOME || (claude ? process.argv.length !== 2 : process.argv[2] !== "acp"))
  throw Error("Expected the ACP command and a dedicated home");
if (
  claude &&
  (process.env.CLAUDE_CONFIG_DIR !== join(process.env.HOME, ".claude") ||
    process.env.CLAUDE_AGENT_ACP_PROTOCOL !== "v1" ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN)
)
  throw Error("Expected an isolated Claude CLI environment");
const autoApprove = process.argv.slice(3).includes("--dangerously-skip-permissions");
const provider = claude ? "Claude" : "Antigravity";
const modelId = claude ? "claude-fixture" : "gemini-fixture";
const effortId = claude ? "effort" : "thought_level";
const path = (name) => join(process.env.HOME, name);
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let session;
let pending;
let botServer;
const available = {
  model: [
    { value: modelId, name: claude ? "Sonnet Fixture" : "Gemini Fixture" },
    { value: modelId + "-pro", name: claude ? "Opus Fixture" : "Gemini Pro Fixture" },
  ],
  [effortId]: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
  mode: [
    { value: "default", name: "Default" },
    { value: claude ? "acceptEdits" : "accept-edits", name: "Accept edits" },
    ...(claude ? [{ value: "plan", name: "Plan mode" }] : []),
    ...(claude && existsSync(path("native-deny")) ? [{ value: "dontAsk", name: "Deny unapproved" }] : []),
    ...(claude && existsSync(path("native-auto")) ? [{ value: "auto", name: "Auto" }] : []),
    ...(claude && existsSync(path("native-full")) ? [{ value: "bypassPermissions", name: "Bypass" }] : []),
  ],
};
const config = () =>
  Object.entries(available).map(([id, options]) => ({
    id,
    currentValue: session[id],
    options:
      claude && id === effortId && session.model.endsWith("-pro")
        ? [{ value: "medium", name: "Medium" }, options[1]]
        : options,
  }));
const update = (data) => send({ method: "session/update", params: { sessionId: session.id, update: data } });
const message = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
function complete(reply) {
  update({ sessionUpdate: "usage_update", size: 1048576, used: 8000 });
  message(reply);
  send({
    id: pending,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        thoughtTokens: 1,
        cachedReadTokens: 4,
        cachedWriteTokens: 0,
        totalTokens: 25,
      },
    },
  });
  pending = undefined;
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          ...(claude ? { auth: { status: {} }, mcpCapabilities: { acp: true } } : { mcpCapabilities: { http: true } }),
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: true, embeddedContext: true },
        },
      },
    });
  } else if (claude && method === "auth/status") {
    send({ id, result: { state: existsSync(path("signed-in")) ? "authenticated" : "unauthenticated" } });
  } else if (method === "session/new" || method === "session/resume") {
    if (!existsSync(path("signed-in"))) {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    if (method === "session/resume") session = JSON.parse(readFileSync(path(params.sessionId), "utf8"));
    else {
      session = { id: randomUUID(), model: modelId, [effortId]: "high", mode: claude ? "acceptEdits" : "accept-edits" };
      botServer = params.mcpServers?.[0];
      if (botServer && claude) {
        const options = params._meta.claudeCode.options;
        if (
          botServer.type !== "acp" ||
          options.tools.length ||
          options.settingSources.length ||
          !options.strictMcpConfig ||
          options.allowDangerouslySkipPermissions ||
          !params._meta.systemPrompt.includes("Follow Bot instructions")
        )
          throw Error("Missing isolated Bot tool policy");
      } else if (botServer) {
        const name = process.argv[process.argv.indexOf("--agent") + 1];
        const agent = readFileSync(join(params.cwd, ".agents", "agents", name + ".md"), "utf8");
        if (
          botServer.type !== "http" ||
          !process.argv.includes("--sandbox") ||
          !process.argv.includes("--process-per-session") ||
          !agent.includes('tools: ["send_message"]') ||
          !agent.includes("inheritMcp: false") ||
          !agent.includes("Follow Bot instructions")
        )
          throw Error("Missing isolated Antigravity Bot tool policy");
      }
      writeFileSync(path(session.id), JSON.stringify(session));
    }
    send({ id, result: { sessionId: session.id, configOptions: config() } });
  } else if (method === "session/set_config_option") {
    if (
      !config()
        .find((option) => option.id === params.configId)
        ?.options.some(({ value }) => value === params.value)
    ) {
      send({ id, error: { code: -32602, message: "Unsupported option" } });
      continue;
    }
    session[params.configId] = params.value;
    send({ id, result: { configOptions: config() } });
  } else if (method === "session/prompt") {
    if (!available.mode.some(({ value }) => value === session.mode) || params.sessionId !== session.id)
      throw Error("Wrong native session or mode");
    const text = params.prompt[0].text.split("Current user message:\n").at(-1);
    pending = id;
    if (botServer) {
      send({
        id: "bot-native-permission",
        method: "session/request_permission",
        params: {
          sessionId: session.id,
          toolCall: { title: "Bash" },
          options: [{ optionId: "unsafe", kind: "allow_once" }],
        },
      });
    } else if (text.includes("antigravity.approval") || text.includes("claude.approval")) {
      if (autoApprove) {
        complete("Fixture native auto-approval active.");
        continue;
      }
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Private test thought" } });
      update({ sessionUpdate: "tool_call", toolCallId: "fixture-tool", title: "Fixture edit", status: "pending" });
      send({
        id: "approve",
        method: "session/request_permission",
        params: {
          sessionId: session.id,
          toolCall: { title: "Fixture edit" },
          options: [
            {
              optionId: "yes",
              kind: "allow_once",
              name: "Allow once",
            },
          ],
        },
      });
    } else if (text.includes("claude.mode")) complete(session.mode);
    else if (text.includes("antigravity.hold") || text.includes("claude.hold"))
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Waiting for cancellation" } });
    else if (session.model === modelId + "-pro")
      complete(
        session[effortId] === "medium" ? "Claude Pro fixture reply (medium)." : `${provider} Pro fixture reply.`,
      );
    else complete(`${provider} reply (${session[effortId]}).`);
  } else if (method === "session/cancel") {
    if (pending !== undefined) send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  } else if (!method && id === "bot-native-permission") {
    if (result?.outcome?.outcome !== "cancelled") throw Error("Unexpected native approval");
    if (claude) {
      send({
        id: "bot-list",
        method: "mcp/message",
        params: {
          serverId: botServer.serverId,
          requestId: "bot-list-request",
          method: "tools/list",
        },
      });
    } else {
      send({
        id: "bot-http-permission",
        method: "session/request_permission",
        params: {
          sessionId: session.id,
          toolCall: { kind: "other", name: "mcp_panda_panda_bot_decide", title: "Run mcp_panda_panda_bot_decide" },
          options: [
            { optionId: "selected", kind: "allow_once" },
            { optionId: "persistent", kind: "allow_always" },
          ],
        },
      });
    }
  } else if (!method && id === "bot-http-permission") {
    if (result?.outcome?.optionId !== "selected") throw Error("Expected one-time tool authorization");
    const response = await fetch(botServer.url, {
      method: "POST",
      headers: Object.fromEntries(botServer.headers.map(({ name, value }) => [name, value])),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bot-named-tool",
        method: "tools/call",
        params: { name: "panda_bot_decide", arguments: {} },
      }),
    });
    if (!response.ok || (await response.json()).result?.content[0].text !== "allowed") throw Error("Wrong tool result");
    complete("Antigravity Bot fixture finished.");
  } else if (!method && id === "bot-list") {
    if (result?.result?.tools?.length !== 1 || result.result.tools[0].name !== "panda_bot_decide")
      throw Error("Wrong application tools");
    send({
      id: "bot-call",
      method: "mcp/message",
      params: {
        serverId: botServer.serverId,
        requestId: "bot-call-request",
        method: "tools/call",
        params: { name: "panda_bot_decide", arguments: {} },
      },
    });
  } else if (!method && id === "bot-call") {
    if (result?.result?.resultType !== "complete" || result.result.content[0].text !== "allowed")
      throw Error("Invalid tool result");
    complete("Claude Bot fixture finished.");
  } else if (!method && id === "approve" && pending !== undefined) {
    update({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", status: "completed" });
    complete(result.outcome.outcome === "selected" ? "Fixture approval received." : "Fixture approval cancelled.");
  }
}
