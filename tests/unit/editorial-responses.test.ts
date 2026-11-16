import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesEditorialModel } from "../../src/server/editorial/adapters/responses.js";
import { configuredEditorialModels } from "../../src/server/editorial/integration/model-config.js";
import type { EditorialModelRun } from "../../src/server/editorial/model/contracts.js";

const input = {
  schema: 1 as const,
  mode: "proofread" as const,
  segments: [{ id: "known", path: [0, 0], start: 0, text: "This are a test." }],
  truncated: false,
};
const run = (): EditorialModelRun => ({
  operationId: "task:0",
  attempt: 1,
  generation: 0,
  signal: new AbortController().signal,
});
const output = (content = '{"edits":[]}') => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
});

test("Responses processing is stateless, tool-free, source-only and strictly validates provider output", async () => {
  const requests: { url: unknown; options: RequestInit }[] = [];
  let result: Response = Response.json(output());
  const send = (async (url, options) => {
    requests.push({ url, options: options! });
    return result;
  }) as typeof fetch;
  const model = new ResponsesEditorialModel(
    {
      id: "review",
      model: "chosen-model",
      endpoint: "https://processor.example/v1/responses",
      credential: async () => "fixture-credential",
    },
    send,
  );
  expect(await model.process(input, run())).toBe('{"edits":[]}');
  const request = requests[0]!,
    body = JSON.parse(String(request.options.body));
  expect(request.options.redirect).toBe("error");
  expect(request.options.headers).toEqual({
    "content-type": "application/json",
    authorization: "Bearer fixture-credential",
  });
  expect(body.model).toBe("chosen-model");
  expect(body.tools).toEqual([]);
  expect(body.tool_choice).toBe("none");
  expect(body.store).toBe(false);
  expect(body.stream).toBe(false);
  expect(body.text.format.strict).toBe(true);
  expect(body.instructions).toContain("Do not summarize");
  expect(body.instructions).toContain("untrusted document data");
  expect(JSON.parse(body.input[0].content[0].text)).toEqual({
    mode: "proofread",
    segments: [{ segmentId: "known", text: "This are a test." }],
  });
  expect(JSON.stringify(body)).not.toContain('"path"');
  expect(JSON.stringify(body)).not.toContain("fixture-credential");
  const invalid = [
    {},
    { status: "incomplete", output: [] },
    { status: "completed", output: [{ type: "function_call", name: "exec_command" }] },
    {
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] }],
    },
    output(""),
    output("x".repeat(524289)),
  ];
  for (const value of invalid) {
    result = Response.json(value);
    await expect(model.process(input, run())).rejects.toThrow("invalidOutput");
  }
  result = new Response("text", { headers: { "content-type": "text/plain" } });
  await expect(model.process(input, run())).rejects.toThrow("invalidOutput");
  result = new Response("private account details", { status: 401 });
  await expect(model.process(input, run())).rejects.toThrow("Editorial processor request failed");
  result = new Response("x".repeat(1048577), { headers: { "content-type": "application/json" } });
  await expect(model.process(input, run())).rejects.toThrow("invalidOutput");
});

test("administrator configuration validates destinations and keeps rotating file credentials out of profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-editorial-config-"));
  try {
    expect(configuredEditorialModels(root, {}).size).toBe(0);
    expect(() => configuredEditorialModels(root, { PANDA_FORCE_EDITORIAL_CONFIG_FILE: join(root, "missing") })).toThrow(
      "Invalid editorial processor configuration",
    );
    mkdirSync(join(root, "config"));
    const path = join(root, "config", "editorial-processors.json"),
      secret = join(root, "key.txt");
    const entry = {
      kind: "responses",
      id: "review",
      model: "selected",
      endpoint: "http://127.0.0.1:1000/responses",
      apiKeyFile: secret,
    };
    const save = (value: unknown) => writeFileSync(path, JSON.stringify({ schema: 1, processors: value }));
    for (const value of [
      {},
      [entry, entry],
      [{ ...entry, id: "../bad" }],
      [{ ...entry, endpoint: "file:///etc/passwd" }],
      [{ ...entry, endpoint: "https://user:password@example.com/responses" }],
      [{ ...entry, endpoint: "https://example.com/responses?token=bad" }],
      [{ ...entry, apiKeyFile: "relative" }],
      [{ ...entry, endpoint: "http://internal.example/responses" }],
      [{ ...entry, command: "run" }],
      [{ ...entry, authentication: "none" }],
    ]) {
      save(value);
      expect(() => configuredEditorialModels(root, {})).toThrow("Invalid editorial processor configuration");
    }
    save([
      {
        ...entry,
        endpoint: "http://internal.example/responses",
        allowInsecureHttp: true,
        authentication: "none",
        apiKeyFile: undefined,
      },
    ]);
    expect(configuredEditorialModels(root, {}).size).toBe(1);
    save([entry]);
    writeFileSync(secret, "first-fixture-key\n", { mode: 0o600 });
    const models = configuredEditorialModels(root, {}),
      profile = models.get("review")!.profile;
    expect(JSON.stringify(profile)).not.toContain("first-fixture-key");
    expect(JSON.stringify(profile)).not.toContain("127.0.0.1");
    expect(JSON.stringify(profile)).not.toContain(secret);
    expect(profile.model).toBe("selected");
    save([{ ...entry, model: "other" }]);
    expect(configuredEditorialModels(root, {}).get("review")!.profile.version).not.toBe(profile.version);
    expect(Object.isFrozen(profile)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
