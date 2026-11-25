#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let session, taskTools;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "runtime/capabilities") {
    send({ id, result: { sessionWorkspaceRouting: true } });
  } else if (method === "session/create" || method === "session/resume") {
    if (settings.applicationProbe && params.mcpServers) {
      if (params.mode !== "build" || params.mcpServers.length !== 1 || params.mcpServers[0].name !== "panda")
        throw Error("Unexpected scoped ZCode session");
      const [server] = params.mcpServers;
      const rpc = async (method, params) => {
        const reply = await fetch(server.url, {
          method: "POST",
          headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
          body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
        });
        const body = await reply.json();
        if (!reply.ok || body.error) throw Error("MCP fixture request failed");
        return body.result;
      };
      const { tools } = await rpc("tools/list");
      const names = tools.map((tool) => `mcp__panda__${tool.name}`);
      if (tools.some(({ name }) => name === "panda_artifacts_import_file")) names.push("Write");
      if (JSON.stringify(params.toolAllowlist) !== JSON.stringify(names.length ? names : ["pandaforce_no_tools"]))
        throw Error("Expected an exact tool allowlist");
      taskTools = { tools, rpc };
    }
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
    if (taskTools?.tools.length && settings.nativeCreationFile && params.content.includes("Produce the native file.")) {
      if (taskTools.tools.some(({ name }) => name === "panda_images_render")) throw Error("Borrowed image renderer");
      const file = params.content.includes("Produce the native image.")
        ? settings.nativeCreationImage
        : settings.nativeCreationFile;
      writeFileSync(join(session.workspace.workspacePath, file.name), Buffer.from(file.content, file.encoding));
      await taskTools.rpc("tools/call", {
        name: "panda_creation_turn",
        arguments: { action: "deliver" },
      });
      await taskTools.rpc("tools/call", { name: "panda_creation_context", arguments: {} });
      const save = async (filename) =>
        taskTools.rpc("tools/call", {
          name: "panda_artifacts_import_file",
          arguments: { kind: file.kind, filename, title: "Native artifact proof" },
        });
      if (!(await save("../" + file.name)).isError) throw Error("Native output traversal was accepted");
      if ((await save(file.name)).isError) throw Error("Native output could not be saved");
    } else if (taskTools?.tools.length && settings.creationReply) {
      await taskTools.rpc("tools/call", {
        name: "panda_creation_turn",
        arguments: { action: "reply", text: settings.creationReply },
      });
    } else if (taskTools?.tools.length) {
      if (settings.expectedInstruction && !params.content.includes(settings.expectedInstruction))
        throw Error("Missing task instructions");
      for (const { name } of taskTools.tools)
        await taskTools.rpc("tools/call", {
          name,
          arguments: name === "panda_bot_chat_reply" ? { text: "Scoped ZCode Bot reply." } : {},
        });
    }
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
