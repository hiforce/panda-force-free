import { CLI_COMMANDS, type CliCommandId } from "../../shared/cli/commands.js";
import { CliError, cliId, cliObject, type CliGrant } from "../../shared/cli/contracts.js";
import { cliCommandArguments, cliCommandAllowed } from "../../shared/cli/schema.js";
export interface CliContentCommands {
  execute(owner: string, id: CliCommandId, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
/** A closed capability map gates each use case; no generic Web or native RPC forwarding exists. */
export async function executeCliCommand(
  grant: CliGrant,
  input: unknown,
  commands: CliContentCommands,
  signal: AbortSignal,
) {
  const p = cliObject(input, ["schema", "command", "args"]);
  if (p.schema !== 1) throw new CliError("invalidInput");
  const spec = CLI_COMMANDS.find((c) => c.id === p.command);
  if (!spec) throw new CliError("notFound", 404);
  if (!grant.capabilities.includes(spec.capability)) throw new CliError("forbidden", 403);
  const args = cliCommandArguments(spec, p.args);
  if (!cliCommandAllowed(spec, args, grant.capabilities)) throw new CliError("forbidden", 403);
  const project = cliId(args.project);
  if (!grant.projects.includes(project)) throw new CliError("forbidden", 403);
  signal.throwIfAborted();
  return commands.execute(grant.owner, spec.id, args, signal);
}
