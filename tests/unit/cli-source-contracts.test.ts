import { expect, test } from "bun:test";
import { CLI_COMMANDS, cliFlagName } from "../../src/shared/cli/commands.js";
import { cliCommandArguments, cliCommandSchema } from "../../src/shared/cli/schema.js";
import { selectedSourceKinds } from "../../src/shared/content-sources/selection.js";
import { knowledgeSelection } from "../../src/shared/knowledge/task-validation.js";

test("content commands never shadow global CLI flags and source schemas share the closed kind selection", () => {
  const reserved = new Set(["profile", "json", "timeout", "help", "version", "input"]);
  for (const spec of CLI_COMMANDS)
    for (const field of spec.fields) expect(reserved.has(cliFlagName(field))).toBe(false);
  const spec = CLI_COMMANDS.find((item) => item.id === "sources.read")!,
    schema = cliCommandSchema(spec),
    input = Object.freeze({ project: "project-1", id: "c-source", contentKinds: Object.freeze(["web", "slides"]) });
  const args = cliCommandArguments(spec, input);
  expect(args.contentKinds).toEqual(["slides", "web"]);
  expect(input.contentKinds).toEqual(["web", "slides"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.contentKinds).toMatchObject({
    type: "array",
    uniqueItems: true,
    items: { enum: ["document", "slides", "web"] },
  });
  expect(selectedSourceKinds(undefined)).toEqual(["document"]);
  expect(selectedSourceKinds(["web", "web"])).toBeNull();
  expect(() => cliCommandArguments(spec, { ...input, contentKinds: ["filesystem"] })).toThrow("invalidInput");
  expect(knowledgeSelection({ project: "project-1", ids: ["doc-1"] })).toEqual({
    project: "project-1",
    ids: ["doc-1"],
  });
});
