import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createCodexBridge } from "../../src/server/bridge/codex-process.js";
import { createCodexApplicationEngine } from "../../src/server/engines/application-tools/codex.js";
import { documentCreationTools } from "../../src/server/creation/document-tools.js";
import { CreationOutputs } from "../../src/server/creation/outputs.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { isolatedApplicationEngines } from "../../src/server/engines/application-tools/factory.js";

const root = await mkdtemp(join(tmpdir(), "panda-application-cli-")),
  evidence = resolve(process.env.PANDA_FORCE_APPLICATION_TOOL_EVIDENCE_DIR || ".artifacts/application-tools-real-cli"),
  work = join(root, "work"),
  socketPath = join(root, "app.sock"),
  owner = "operator:test-user",
  requests = [],
  normalEvents = [],
  calls = [],
  results = [],
  interrupts = [],
  ordinaryIds = [];
await mkdir(evidence, { recursive: true });
// CLI helper executables intentionally reject model homes under the system temporary directory.
const home = await mkdtemp(join(evidence, "model-home-"));
await mkdir(join(home, ".codex"), { recursive: true });
await mkdir(work);
const ambientMcp = join(root, "ambient-mcp.mjs");
await writeFile(
  ambientMcp,
  `import readline from "node:readline";
for await (const line of readline.createInterface({input:process.stdin})) {
  let request; try { request=JSON.parse(line); } catch { continue; }
  if (request.id===undefined) continue;
  let result={};
  if (request.method==="initialize") result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"isolated-ambient-fixture",version:"1"}};
  else if (request.method==="tools/list") result={tools:[{name:"private_probe",description:"Synthetic ambient tool that must never enter a scoped application thread",inputSchema:{type:"object",properties:{}}}]};
  else if (request.method==="tools/call") result={content:[{type:"text",text:"Synthetic isolated fixture only"}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
}
`,
);
const flatten = (tools, namespace = null) =>
  (tools || []).flatMap((tool) =>
    tool.tools ? flatten(tool.tools, tool.name) : [{ name: tool.name || tool.type, namespace }],
  );
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const generated = {
  title: "A real application artifact",
  body: richDocumentFromMarkdown("## Verified source\n\nPersisted through the application and local Git."),
};
let providerFailure = null,
  stderr = "",
  child,
  control,
  stopping = false,
  files,
  database,
  knowledgeFeature,
  knowledgeSource,
  knowledgeRuntime = null,
  tasks,
  failure = null;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const input = await request.json(),
        tools = flatten(input.tools),
        knowledge = tools.some((tool) => tool.name.startsWith("panda_knowledge_")),
        creative = knowledge || JSON.stringify(input).includes("SCOPED_APPLICATION_"),
        outputs = (input.input || []).filter((item) => item.type === "function_call_output");
      requests.push({ creative, knowledge, tools, outputs: outputs.length });
      let item;
      const reviewing = tools.some((tool) => tool.name === "panda_knowledge_review_decision");
      if (knowledge && outputs.length < (reviewing ? 3 : 2)) {
        assert.ok(knowledgeSource);
        const listed = await control.request("thread/list", { limit: 100 });
        assert.deepEqual(
          listed.data.map((thread) => thread.id).sort(),
          [...ordinaryIds].sort(),
          "Active ephemeral knowledge tasks must not appear in ordinary session history",
        );
        const allowed = reviewing
          ? [
              "panda_knowledge_review_source",
              "panda_knowledge_review_draft",
              "panda_knowledge_review_decision",
              "request_user_input",
            ]
          : ["panda_knowledge_context", "panda_knowledge_ask", "panda_knowledge_draft", "request_user_input"];
        assert.ok(
          tools.every((tool) => allowed.includes(tool.name)),
          "Knowledge threads cannot inherit ambient tools or resources",
        );
        const name = reviewing
          ? ["panda_knowledge_review_source", "panda_knowledge_review_draft", "panda_knowledge_review_decision"][
              outputs.length
            ]
          : ["panda_knowledge_context", "panda_knowledge_draft"][outputs.length];
        const arguments_ =
          outputs.length === 0
            ? { id: knowledgeSource.id, start: 0 }
            : reviewing && outputs.length === 1
              ? { start: 0 }
              : reviewing
                ? {
                    schema: 1,
                    verdict: "approve",
                    summary: "The complete knowledge draft is faithful to its selected source.",
                    checks: {
                      faithfulness: true,
                      coverage: true,
                      separation: true,
                      clarity: true,
                      contradictions: true,
                    },
                    claims: [
                      {
                        id: "native-c1",
                        supported: true,
                        reason: "The original source explicitly records application and local Git persistence.",
                      },
                    ],
                    issues: [],
                  }
                : {
                    schema: 1,
                    title: "Native reviewed knowledge",
                    summary: "Use the application and Git to persist output.",
                    claims: [
                      {
                        id: "native-c1",
                        kind: "source",
                        text: "The selected source records application and local Git persistence.",
                        evidence: [
                          {
                            sourceId: knowledgeSource.id,
                            version: knowledgeSource.version,
                            quote: "Persisted through the application and local Git.",
                          },
                        ],
                      },
                    ],
                    uncertainties: [],
                  };
        const tool = tools.find((tool) => tool.name === name);
        assert.ok(tool);
        item = {
          id: "function-" + requests.length,
          type: "function_call",
          call_id: "call-" + requests.length,
          name,
          arguments: JSON.stringify(arguments_),
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
        };
      } else if (creative && !knowledge && outputs.length < 2) {
        assert.ok(tools.every((tool) => ["panda_documents_create", "request_user_input"].includes(tool.name)));
        const tool = tools.find((tool) => tool.name === "panda_documents_create");
        assert.ok(tool);
        item = {
          id: "function-" + requests.length,
          type: "function_call",
          call_id: "call-" + requests.length,
          name: tool.name,
          arguments: JSON.stringify(generated),
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
        };
      } else
        item = {
          id: "message-" + requests.length,
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [
            {
              type: "output_text",
              text: creative ? "Saved through the application." : "Ordinary coding session completed.",
            },
          ],
        };
      const id = "response-" + requests.length;
      return new Response(
        event("response.created", { response: { id, status: "in_progress", output: [] } }) +
          event("response.output_item.done", { output_index: 0, item }) +
          event("response.completed", {
            response: {
              id,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          }),
        { headers: { "content-type": "text/event-stream" } },
      );
    } catch (error) {
      providerFailure = String(error);
      return new Response("Invalid isolated model request", { status: 400 });
    }
  },
});
async function until(check, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Isolated CLI observation timed out");
    await Bun.sleep(10);
  }
}
try {
  const config = {
      model_provider: "application_fixture",
      model: "application-fixture",
      "model_providers.application_fixture.name": "Isolated application fixture",
      "model_providers.application_fixture.base_url": `http://127.0.0.1:${provider.port}`,
      "model_providers.application_fixture.wire_api": "responses",
      "model_providers.application_fixture.requires_openai_auth": false,
      "model_providers.application_fixture.supports_websockets": false,
      "features.enable_request_compression": false,
      "mcp_servers.ambient_fixture.command": process.execPath,
      "mcp_servers.ambient_fixture.args": [ambientMcp],
    },
    args = ["app-server", "--listen", "unix://" + socketPath];
  for (const [key, value] of Object.entries(config)) args.push("-c", key + "=" + JSON.stringify(value));
  child = spawn("codex", args, {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
    },
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-12000);
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error("Isolated CLI exited: " + stderr);
    try {
      // The CLI publishes its Unix listener through an atomic symlink in this owned fixture directory.
      return (await stat(socketPath)).isSocket();
    } catch {
      return false;
    }
  });
  control = createCodexBridge({
    connection: { mode: "shared", socketPath },
    defaultCwd: work,
    clientInfo: { name: "panda-ordinary-fixture", title: "Ordinary fixture", version: "test" },
    isShuttingDown: () => stopping,
    onConnected() {},
    onDisconnected() {},
    onMessage: (message) => normalEvents.push(message),
  });
  async function ordinary(marker) {
    const { thread } = await control.request("thread/start", {
        cwd: work,
        ephemeral: false,
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions: marker,
      }),
      { turn } = await control.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Return the fixture response." }],
      });
    await until(() =>
      normalEvents.some(
        (message) =>
          message.method === "turn/completed" &&
          message.params?.threadId === thread.id &&
          message.params?.turn?.id === turn.id,
      ),
    );
    assert.equal(
      normalEvents.find((message) => message.method === "turn/completed" && message.params?.threadId === thread.id)
        .params.turn.status,
      "completed",
    );
    ordinaryIds.push(thread.id);
  }
  await ordinary("ORDINARY_APPLICATION_BEFORE");
  files = await projectFileApiFixture();
  const databasePath = join(root, "creation.sqlite"),
    contentRoot = join(root, "outputs");
  database = openCreationDatabase(databasePath);
  tasks = new CreationTaskRepository(database);
  const adapter = new FileCreationDocumentOutput(contentRoot, files.application().navigation),
    outputs = new CreationOutputs(tasks, adapter, adapter),
    spec = {
      schema: 1,
      id: randomUUID(),
      owner,
      projectId: "project-1",
      operationId: randomUUID(),
      kind: "document",
      target: { parentId: null, treeVersion: 0, locale: "en" },
      inputDigest: "a".repeat(64),
      skillCaptureId: null,
    };
  tasks.create(spec, Date.now());
  const lease = tasks.claim(owner, spec.id, Date.now(), 30000),
    tools = documentCreationTools(lease, tasks, outputs),
    engine = createCodexApplicationEngine(
      {
        connection: { mode: "shared", socketPath },
        scratchDirectory: work,
        version: "test",
        timeoutMs: 30000,
      },
      (options) => {
        const bridge = createCodexBridge(options);
        return {
          get connected() {
            return bridge.connected;
          },
          async request(method, params) {
            const result = await bridge.request(method, params);
            if (method === "turn/interrupt")
              interrupts.push({ sessionId: params.threadId, runId: params.turnId, acknowledged: true });
            return result;
          },
          sendRaw: bridge.sendRaw,
          start: bridge.start,
          terminate: bridge.terminate,
          fullyStopped: bridge.fullyStopped,
          cancelRestart: bridge.cancelRestart,
          rejectPending: bridge.rejectPending,
        };
      },
    );
  const result = await engine.run(
    {
      prompt: "SCOPED_APPLICATION_DOCUMENT: create the fixture document.",
      instructions: "Use only the application tool and return its receipt.",
      tools: tools.definitions,
    },
    {
      signal: AbortSignal.timeout(35000),
      started: tools.started,
      async call(call) {
        calls.push({ sessionId: call.sessionId, runId: call.runId, callId: call.callId });
        const result = await tools.call(call);
        results.push(JSON.parse(result.text));
        return result;
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], results[1]);
  const saved = tasks.get(owner, spec.id);
  assert.equal(saved.state, "succeeded");
  assert.equal((await files.application().navigation.tree("project-1")).nodes.length, 1);
  const detail = await files.application().queries.detail("project-1", saved.artifact.documentId);
  assert.deepEqual(detail.revision.body, generated.body);
  const head = await files.snapshots.head();
  database.close();
  files.reopen();
  database = openCreationDatabase(databasePath);
  tasks = new CreationTaskRepository(database);
  const reopened = new FileCreationDocumentOutput(contentRoot, files.application().navigation),
    recovery = new CreationOutputs(tasks, reopened, reopened);
  assert.deepEqual((await recovery.reconcile(owner, spec.id)).artifact, saved.artifact);
  assert.equal(await files.snapshots.head(), head);
  const cancelledSpec = {
    ...spec,
    id: randomUUID(),
    operationId: randomUUID(),
    target: { ...spec.target, treeVersion: 1 },
  };
  tasks.create(cancelledSpec, Date.now());
  const cancelledLease = tasks.claim(owner, cancelledSpec.id, Date.now(), 30000);
  let release, staged;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    ready = new Promise((resolve) => {
      staged = resolve;
    }),
    guarded = new CreationOutputs(
      tasks,
      {
        async stage(value) {
          const digest = await reopened.stage(value);
          staged();
          await held;
          return digest;
        },
      },
      reopened,
    ),
    cancelledTools = documentCreationTools(cancelledLease, tasks, guarded),
    controller = new AbortController(),
    cancelled = engine
      .run(
        {
          prompt: "SCOPED_APPLICATION_CANCEL: create a cancellable document.",
          instructions: "Use only the application tool.",
          tools: cancelledTools.definitions,
        },
        { signal: controller.signal, started: cancelledTools.started, call: cancelledTools.call },
      )
      .catch((error) => error);
  await ready;
  tasks.cancel(owner, cancelledSpec.id, Date.now());
  controller.abort();
  release();
  assert.match(String(await cancelled), /interrupted/);
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].acknowledged, true);
  assert.equal(tasks.get(owner, cancelledSpec.id).state, "cancelled");
  assert.equal(tasks.get(owner, cancelledSpec.id).outputDigest, null);
  assert.equal(await files.snapshots.head(), head);
  const knowledgeContent = new FileDocumentKnowledgeContent(files.application().projectContent),
    captured = await knowledgeContent.capture(owner, { project: "project-1", ids: [saved.artifact.documentId] }),
    engines = isolatedApplicationEngines({
      connection: { mode: "shared", socketPath },
      scratchRoot: join(work, "knowledge"),
      version: "test",
      engineId: "codex",
      purpose: "knowledge",
    });
  knowledgeSource = captured.sources[0];
  knowledgeFeature = createKnowledgeFeature({
    stateRoot: join(root, "knowledge-state"),
    content: knowledgeContent,
    profile: async () => ({ id: "native", engineId: "codex", model: "application-fixture", activeTimeoutMs: 30000 }),
    engine: (profile) => engines.select(profile),
    available: () => true,
    owner: () => owner,
    report: (error) => {
      providerFailure ??= "Knowledge workflow: " + String(error);
    },
  });
  await knowledgeFeature.reviewSettings.configure(owner, "project-1", { automatic: true, revision: 0 });
  const knowledgeTask = await knowledgeFeature.service.submit(owner, {
    id: randomUUID(),
    project: "project-1",
    ids: [saved.artifact.documentId],
    purpose: "SCOPED_APPLICATION_KNOWLEDGE: explain persistence.",
  });
  knowledgeFeature.start();
  await until(
    async () => (await knowledgeFeature.service.status(owner, knowledgeTask.id)).state === "completed",
    45000,
  );
  const knowledgeDetail = await knowledgeFeature.service.detail(owner, knowledgeTask.id),
    knowledgeReview = await knowledgeFeature.reviewSettings.detail(owner, knowledgeTask.id);
  assert.equal(knowledgeDetail.task.automaticReview.state, "passed");
  assert.equal(knowledgeReview.report.verdict, "approve");
  assert.equal(knowledgeDetail.draft.claims[0].evidence[0].quote, "Persisted through the application and local Git.");
  assert.notEqual(await files.snapshots.head(), head);
  knowledgeRuntime = {
    separateGeneratorAndReviewer: true,
    automaticApprovalSaved: true,
    exactEvidence: true,
    scopedNativeToolsOnly: true,
    fileAndGitCommit: knowledgeDetail.task.result.commit,
  };
  await knowledgeFeature.close();
  knowledgeFeature = null;
  await ordinary("ORDINARY_APPLICATION_AFTER");
  await until(async () => {
    const listed = await control.request("thread/list", { limit: 100 });
    return ordinaryIds.every((id) => listed.data.some((thread) => thread.id === id));
  });
  assert.deepEqual(
    (await control.request("thread/list", { limit: 100 })).data.map((thread) => thread.id).sort(),
    [...ordinaryIds].sort(),
  );
  knowledgeRuntime.ordinaryHistoryIsolated = true;
  assert.equal(providerFailure, null);
  const normal = requests.filter((request) => !request.creative);
  assert.equal(normal.length, 2);
  assert.deepEqual(normal[0].tools, normal[1].tools);
  assert.ok(
    normal.every((request) =>
      request.tools.some((tool) => tool.name === "private_probe" && tool.namespace === "mcp__ambient_fixture"),
    ),
    "Ordinary sessions retain their configured MCP tools before and after an isolated application run",
  );
  assert.ok(normal.every((request) => !request.tools.some((tool) => tool.name === "panda_documents_create")));
  assert.equal(
    normalEvents.filter((message) => message.id !== undefined && message.method === "item/tool/call").length,
    0,
  );
  assert.equal(child.exitCode, null);
  console.log(
    "Actual CLI application tools, reviewed knowledge, file/Git persistence, duplicate recovery, cancellation and ordinary session isolation verified.",
  );
} catch (error) {
  failure = error.stack || String(error);
  process.exitCode = 1;
} finally {
  stopping = true;
  if (control) {
    control.cancelRestart();
    control.rejectPending(new Error("Fixture shutdown"));
    control.terminate();
  }
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 2000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
  database?.close();
  await knowledgeFeature?.close();
  await files?.close();
  provider.stop(true);
  const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim();
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: !failure,
        failure,
        version,
        requests,
        calls,
        results,
        interrupts,
        knowledgeRuntime,
        realExternalModelCalls: false,
        productionDaemonOrHomeUsed: false,
        applicationEntryPointDeployed: false,
        stderr,
      },
      null,
      2,
    ) + "\n",
  );
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  if (failure) console.error(failure);
}
