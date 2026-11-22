#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

if (process.argv[2] !== "acp" || !process.env.HOME) throw Error("Expected agy acp and a dedicated home");
const path = (name) => join(process.env.HOME, name);
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let session;
let pending;
const available = {
  model: [
    { value: "gemini-fixture", name: "Gemini Fixture" },
    { value: "gemini-fixture-pro", name: "Gemini Pro Fixture" },
  ],
  thought_level: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
  mode: [
    { value: "default", name: "Default" },
    { value: "accept-edits", name: "Accept edits" },
  ],
};
const config = () => Object.entries(available).map(([id, options]) => ({ id, currentValue: session[id], options }));
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
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: true, embeddedContext: true },
        },
      },
    });
  } else if (method === "session/new" || method === "session/resume") {
    if (!existsSync(path("signed-in"))) {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    if (method === "session/resume") session = JSON.parse(readFileSync(path(params.sessionId), "utf8"));
    else {
      session = { id: randomUUID(), model: "gemini-fixture", thought_level: "high", mode: "accept-edits" };
      writeFileSync(path(session.id), JSON.stringify(session));
    }
    send({ id, result: { sessionId: session.id, configOptions: config() } });
  } else if (method === "session/set_config_option") {
    session[params.configId] = params.value;
    send({ id, result: { configOptions: config() } });
  } else if (method === "session/prompt") {
    if (session.mode !== "default" || params.sessionId !== session.id) throw Error("Wrong native session or mode");
    const text = params.prompt[0].text.split("Current user message:\n").at(-1);
    pending = id;
    if (text.includes("antigravity.approval")) {
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
    } else if (text.includes("antigravity.hold"))
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Waiting for cancellation" } });
    else if (session.model === "gemini-fixture-pro") complete("Antigravity Pro fixture reply.");
    else complete(`Antigravity reply (${session.thought_level}).`);
  } else if (method === "session/cancel") {
    if (pending !== undefined) send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  } else if (!method && id === "approve" && pending !== undefined) {
    update({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", status: "completed" });
    complete(result.outcome.outcome === "selected" ? "Fixture approval received." : "Fixture approval cancelled.");
  }
}
