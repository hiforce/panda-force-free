import { CliError } from "../shared/cli/contracts.js";
export { cliFlagName } from "../shared/cli/commands.js";
export function cliArguments(argv: string[]) {
  const words: string[] = [],
    flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!/^[a-z][a-z-]*$/.test(name) || name in flags) throw new CliError("invalidInput");
    if (["json", "stdin", "api-key-stdin", "help", "version"].includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new CliError("invalidInput");
    flags[name] = value;
  }
  return { words, flags };
}
export function knownFlags(flags: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(flags).some((name) => !["profile", "json", "timeout", "help", "version", ...names].includes(name)))
    throw new CliError("invalidInput");
}
