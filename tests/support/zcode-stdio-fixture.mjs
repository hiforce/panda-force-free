#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let session;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "runtime/capabilities") {
    send({ id, result: { sessionWorkspaceRouting: true } });
  } else if (method === "session/create" || method === "session/resume") {
    session = {
      sessionId: params.sessionId ?? crypto.randomUUID(),
      workspace: params.workspace,
      mode: params.sessionId ? (settings.resumedMode ?? "build") : "build",
    };
    send({ id, result: { session, settings: { permission: { mode: session.mode } } } });
  } else if (method === "session/setMode" && params.sessionId === session?.sessionId) {
    if (!settings.ignoreMode) session.mode = params.mode;
    const projectionMode = settings.projectionMode ?? session.mode;
    send({
      id,
      result: { session: { ...session, mode: projectionMode }, settings: { permission: { mode: session.mode } } },
    });
  } else if (method === "session/subscribe" && params.sessionId === session?.sessionId) {
    send({ id, result: {} });
  } else if (method === "session/send" && params.sessionId === session?.sessionId) {
    const { inputId, sessionId } = params;
    const turnId = crypto.randomUUID();
    const event = (type, payload, nativeTurn = turnId) =>
      send({ method: "session/event", params: { sessionId, turnId: nativeTurn, type, payload } });
    send({ id, result: { accepted: true, sessionId } });
    event("turn.started", { inputId });
    if (settings.progressDirectory) {
      const waitFor = async (name) => {
        const file = join(settings.progressDirectory, name);
        const deadline = Date.now() + 30000;
        while (!existsSync(file)) {
          if (Date.now() > deadline) throw Error(`Missing fixture signal ${name}`);
          await Bun.sleep(30);
        }
      };
      event("model.streaming", { kind: "reasoning_delta", delta: "Private reasoning fixture text" });
      event("tool.updated", { kind: "started", toolCallId: "stale", toolName: "Stale tool fixture" }, "stale-turn");
      await waitFor("start-tool");
      event("tool.updated", { kind: "scheduled", toolCallId: "fixture-tool", toolName: "Read test file" });
      event("tool.updated", { kind: "started", toolCallId: "fixture-tool", toolName: "Read test file" });
      await waitFor("complete-tool");
      event("tool.updated", { kind: "result", toolCallId: "fixture-tool", result: "Private tool output fixture" });
      await waitFor("answer");
    }
    event("turn.completed", { inputId, resultType: "success", response: `Fixture ZCode ${session.mode} active.` });
  } else send({ id, error: { code: -32601, message: "Unexpected fixture request" } });
}
