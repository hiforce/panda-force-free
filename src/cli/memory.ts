import type { Readable } from "node:stream";
import { CliError } from "../shared/cli/contracts.js";
import { memoryOrganizationOutputLimit, type MemoryOrganizationCli } from "../shared/project-memory/organization.js";
import { knownFlags } from "./arguments.js";

export async function runMemoryCommand(
  command: string,
  flags: Record<string, string | boolean>,
  input: Readable,
  port?: MemoryOrganizationCli,
) {
  const submit = command === "memory submit";
  if (!submit && command !== "memory context") throw new CliError("notFound", 404);
  knownFlags(flags, submit ? ["job", "stdin"] : ["job"]);
  const job = flags.job;
  if (typeof job !== "string" || !/^[a-f0-9]{32}$/u.test(job) || (submit && flags.stdin !== true))
    throw new CliError("invalidInput");
  if (!port) throw new CliError("forbidden", 403);
  if (!submit) return port.context(job);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > memoryOrganizationOutputLimit) throw new CliError("limit", 413);
    chunks.push(bytes);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CliError("invalidInput");
  }
  return port.submit(job, payload);
}
