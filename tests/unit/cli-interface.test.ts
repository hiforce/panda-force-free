import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { CliProfiles } from "../../src/cli/profiles.js";
import { runPandaCli } from "../../src/cli/application.js";
import { cliArguments } from "../../src/cli/arguments.js";
import { cliOutput } from "../../src/cli/output.js";
import { pandaCliManual } from "../../src/shared/cli/manual.js";
import { KNOWLEDGE_AGENT_REFERENCE } from "../../src/cli/agent-guide.js";

test("standard help remains offline, global flags accept either position and draft schemas are explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-interface-"));
  try {
    let output = "",
      errors = "";
    const code = await runPandaCli(
      ["--help", "--json"],
      {
        input: Readable.from([]),
        output: new Writable({
          write(value, _e, done) {
            output += value;
            done();
          },
        }),
        error: new Writable({
          write(value, _e, done) {
            errors += value;
            done();
          },
        }),
      },
      new CliProfiles(root),
    );
    expect(code).toBe(0);
    expect(errors).toBe("");
    const guide = JSON.parse(output),
      edit = guide.commands.find((command: { id: string }) => command.id === "knowledge.edit");
    expect(edit.inputSchema.properties.draft.required).toContain("claims");
    expect(edit.inputSchema.properties.draft.properties.claims.items.properties.evidence.items.required).toContain(
      "quote",
    );
    const previous = guide.commands.find((command: { id: string }) => command.id === "knowledge.previous"),
      approve = guide.commands.find((command: { id: string }) => command.id === "knowledge.approve");
    expect(previous.capability).toBe("knowledge:read");
    expect(previous.inputSchema.properties.offset.type).toBe("integer");
    expect(approve.capability).toBe("knowledge:approve");
    expect(approve.inputSchema.properties.previousState.pattern).toBe("^[a-f0-9]{64}$");
    expect(pandaCliManual()).toContain("--previous-state");
    expect(pandaCliManual()).not.toContain("--previousState");
    expect(KNOWLEDGE_AGENT_REFERENCE).toContain("data.previous.next");
    expect(cliArguments(["--profile", "work", "documents", "list", "--json"]).words).toEqual(["documents", "list"]);
    expect(cliArguments(["documents", "list", "--profile", "work", "--json"]).flags.profile).toBe("work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("profile selection and listing retain only registration metadata, never a key", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-selection-")),
    profiles = new CliProfiles(root);
  try {
    const key = "pfk_" + "a".repeat(24) + "_" + "b".repeat(43);
    expect(await profiles.selected()).toBe("default");
    await profiles.register("work", {
      schema: 1,
      protocol: 1,
      server: "https://panda.example",
      clientId: "client-1",
      kind: "codex",
      credentialRef: "credentials.json",
    });
    await profiles.login("work", key);
    await profiles.use("work");
    expect(await profiles.selected()).toBe("work");
    expect(JSON.stringify(await profiles.list())).not.toContain(key);
    expect((await profiles.list()).profiles[0]!.name).toBe("work");
    await profiles.logout("work");
    expect((await profiles.list()).profiles[0]!.clientId).toBe("client-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("human tables preserve identifiers and remove terminal controls from source titles", () => {
  const text = cliOutput({
    schema: 1,
    data: { documents: [{ id: "doc-1", title: "中文\u001b[31m title", version: "version-1" }], nextOffset: 100 },
  });
  expect(text).toContain("doc-1");
  expect(text).toContain("version-1");
  expect(text).toContain("Next page: 100");
  expect(text).not.toContain("\u001b");
});
