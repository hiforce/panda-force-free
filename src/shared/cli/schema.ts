import { knowledgeDraftSchema } from "../knowledge/schema.js";
import { KNOWLEDGE_LIMITS } from "../knowledge/tasks.js";
import type { CliCommand } from "./commands.js";
import { CliError, cliObject, type CliCapability } from "./contracts.js";
import { SAVED_SOURCE_KINDS, selectedSourceKinds } from "../content-sources/selection.js";
export function cliCommandSchema(spec: CliCommand, capabilities?: readonly CliCapability[]) {
  const properties = Object.fromEntries(
    spec.fields.map((field) => [
      field,
      field === "days"
        ? { type: "integer", enum: [7, 30] }
        : field === "contentKinds"
          ? {
              type: "array",
              items: { type: "string", enum: SAVED_SOURCE_KINDS },
              minItems: 1,
              maxItems: 3,
              uniqueItems: true,
            }
          : field === "previousState"
            ? { type: "string", pattern: "^[a-f0-9]{64}$" }
            : field === "mode"
              ? {
                  type: "string",
                  enum:
                    "semanticCapability" in spec && capabilities && !capabilities.includes(spec.semanticCapability)
                      ? ["text"]
                      : ["text", "semantic", "hybrid"],
                  default: "text",
                }
              : field === "ids"
                ? {
                    type: "array",
                    items: { type: "string", maxLength: 128 },
                    minItems: 1,
                    maxItems: KNOWLEDGE_LIMITS.sources,
                  }
                : field === "answers"
                  ? {
                      type: "array",
                      minItems: 1,
                      maxItems: KNOWLEDGE_LIMITS.questionCount,
                      items: {
                        type: "object",
                        properties: {
                          questionId: { type: "string", maxLength: 128 },
                          answer: { type: "string", minLength: 1, maxLength: 4000 },
                        },
                        required: ["questionId", "answer"],
                        additionalProperties: false,
                      },
                    }
                  : field === "draft"
                    ? knowledgeDraftSchema()
                    : ["offset", "revision"].includes(field)
                      ? { type: "integer", minimum: 0 }
                      : field === "purpose"
                        ? { type: "string", maxLength: KNOWLEDGE_LIMITS.purposeBytes }
                        : { type: "string" },
    ]),
  );
  return { type: "object", properties, required: [...spec.required], additionalProperties: false };
}

/** Local and server dispatch share the closed arguments contract; invalid modes never reach a provider. */
export function cliCommandArguments(spec: CliCommand, input: unknown) {
  const args = { ...cliObject(input, spec.fields) };
  if (spec.required.some((field) => !(field in args))) throw new CliError("invalidInput");
  if (args.days !== undefined && args.days !== 7 && args.days !== 30) throw new CliError("invalidInput");
  if (args.contentKinds !== undefined) {
    const kinds = selectedSourceKinds(args.contentKinds);
    if (!kinds) throw new CliError("invalidInput");
    args.contentKinds = kinds;
  }
  if (
    args.previousState !== undefined &&
    (typeof args.previousState !== "string" || !/^[a-f0-9]{64}$/.test(args.previousState))
  )
    throw new CliError("invalidInput");
  if (
    "semanticCapability" in spec &&
    args.mode !== undefined &&
    (typeof args.mode !== "string" || !["text", "semantic", "hybrid"].includes(args.mode))
  )
    throw new CliError("invalidInput");
  return args;
}

export function cliCommandAllowed(
  spec: CliCommand,
  args: Record<string, unknown>,
  capabilities: readonly CliCapability[],
) {
  return (
    capabilities.includes(spec.capability) &&
    (!("semanticCapability" in spec) ||
      args.mode === undefined ||
      args.mode === "text" ||
      capabilities.includes(spec.semanticCapability))
  );
}
