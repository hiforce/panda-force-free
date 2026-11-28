import { cliOutput, cliErrorText } from "./output.js";
import { pandaIntegration } from "./integrations.js";
import type { Readable, Writable } from "node:stream";
import { CLI_LOCAL_COMMANDS } from "../shared/cli/local-commands.js";
import { CLI_COMMANDS, cliCommandFlag } from "../shared/cli/commands.js";
import { cliCommandSchema } from "../shared/cli/schema.js";
import { CliError, cliObject } from "../shared/cli/contracts.js";
import { cliArguments, knownFlags, cliFlagName } from "./arguments.js";
import { CliProfiles } from "./profiles.js";
import { PandaClient } from "./client.js";
import { servePandaMcp } from "./mcp.js";
import { CLI_VERSION } from "../shared/cli/version.js";
import { pandaCliManual } from "../shared/cli/manual.js";
import { runMemoryCommand } from "./memory.js";
import { creationCallback } from "./creation-callback.js";
import type { MemoryOrganizationCli } from "../shared/project-memory/organization.js";

async function boundedInput(input: Readable) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new CliError("limit", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
async function inputFile(path: string) {
  const file = await import("node:fs/promises"),
    handle = await file.open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new CliError("invalidInput");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function runPandaCli(
  argv: string[],
  io: { input: Readable; output: Writable; error: Writable },
  profiles = new CliProfiles(),
  memory?: MemoryOrganizationCli,
): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { words, flags } = cliArguments(argv);
    const requested = words.join(" "),
      command = flags.help ? "help" : flags.version ? "version" : requested;
    if (command === "creation callback") {
      if (flags.stdin !== true || flags.json !== true || Object.keys(flags).length !== 2)
        throw new CliError("invalidInput");
      const input = await boundedInput(io.input);
      let value: unknown;
      try {
        value = JSON.parse(input);
      } catch {
        throw new CliError("invalidInput");
      }
      io.output.write(JSON.stringify(await creationCallback(value)) + "\n");
      return 0;
    }
    if (words[0] === "memory" && command === requested && ["memory context", "memory submit"].includes(command)) {
      const result = await runMemoryCommand(command, flags, io.input, memory);
      io.output.write(json ? JSON.stringify(result) + "\n" : cliOutput(result));
      return 0;
    }
    const local = ["", "help", "guide", "version"].includes(command);
    const profile =
      typeof flags.profile === "string"
        ? flags.profile
        : process.env.PANDA_PROFILE || (local ? "default" : await profiles.selected());
    const timeout = flags.timeout === undefined ? 60 : Number(flags.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw new CliError("invalidInput");
    const client = new PandaClient(profiles, profile, undefined, timeout * 1000);
    json = flags.json === true;
    let result: unknown;
    if (!command || command === "help" || command === "guide") {
      knownFlags(flags, command === "guide" ? ["format"] : []);
      if (flags.format !== undefined) {
        if (flags.format !== "html" || json) throw new CliError("invalidInput");
        io.output.write(pandaCliManual());
        return 0;
      }
      result = {
        schema: 1,
        version: CLI_VERSION,
        protocol: 1,
        registrationRequired: true,
        authentication: "Registered client plus scoped API key",
        localCommands: CLI_LOCAL_COMMANDS.map(([syntax]) => syntax),
        commands: CLI_COMMANDS.map((spec) => ({ ...spec, inputSchema: cliCommandSchema(spec) })),
      };
    } else if (["integrations install", "integrations inspect", "integrations uninstall"].includes(command)) {
      knownFlags(flags, ["target", "directory"]);
      if (typeof flags.target !== "string" || typeof flags.directory !== "string") throw new CliError("invalidInput");
      result = await pandaIntegration(
        command.split(" ")[1] as "install" | "inspect" | "uninstall",
        flags.target,
        flags.directory,
        profile,
      );
    } else if (command === "version") {
      knownFlags(flags, []);
      result = { version: CLI_VERSION, protocol: 1 };
    } else if (command === "register") {
      knownFlags(flags, ["file"]);
      if (typeof flags.file !== "string") throw new CliError("invalidInput");
      result = await profiles.register(profile, await inputFile(flags.file));
    } else if (command === "auth setup") {
      knownFlags(flags, ["base-url", "api-key-stdin"]);
      if (typeof flags["base-url"] !== "string" || flags["api-key-stdin"] !== true) throw new CliError("invalidInput");
      result = await client.setup(flags["base-url"], await boundedInput(io.input));
    } else if (command === "auth login") {
      knownFlags(flags, ["api-key-stdin"]);
      if (flags["api-key-stdin"] !== true) throw new CliError("invalidInput");
      result = await profiles.login(profile, await boundedInput(io.input));
    } else if (command === "auth logout") {
      knownFlags(flags, []);
      result = await profiles.logout(profile);
    } else if (command === "auth profiles") {
      knownFlags(flags, ["offset"]);
      result = await profiles.list(flags.offset === undefined ? 0 : Number(flags.offset));
    } else if (command === "auth use" || (words[0] === "auth" && words[1] === "use" && words.length === 3)) {
      knownFlags(flags, []);
      result = await profiles.use(words[2] || profile);
    } else if (command === "doctor") {
      knownFlags(flags, []);
      const response = await client.request("session");
      result = {
        schema: 1,
        requestId: response.requestId,
        data: { connected: true, cliVersion: CLI_VERSION, protocol: 1, access: response.data },
      };
    } else if (command === "auth status") {
      knownFlags(flags, []);
      result = await client.request("session");
    } else if (command === "mcp serve") {
      knownFlags(flags, []);
      await servePandaMcp(client, io.input, io.output);
      return 0;
    } else {
      const spec = CLI_COMMANDS.find((spec) => spec.words.join(" ") === command);
      if (!spec) throw new CliError("notFound", 404);
      const secret = "stdinSecret" in spec ? spec.stdinSecret : undefined;
      knownFlags(flags, [...spec.fields.map((field) => cliCommandFlag(spec, field)), ...(secret ? [] : ["input"])]);
      let args: Record<string, unknown>;
      if (typeof flags.input === "string") {
        if (spec.fields.some((field) => cliFlagName(field) in flags)) throw new CliError("invalidInput");
        args = cliObject(await inputFile(flags.input), spec.fields);
      } else {
        args = {};
        for (const field of spec.fields)
          if (field === secret) {
            if (flags[cliCommandFlag(spec, field)] === true) args[field] = await boundedInput(io.input);
          } else if (cliFlagName(field) in flags) {
            const value = flags[cliFlagName(field)];
            args[field] =
              ["ids", "contentKinds"].includes(field) && typeof value === "string"
                ? value.split(",")
                : ["offset", "revision", "days"].includes(field) && typeof value === "string" && /^\d+$/.test(value)
                  ? Number(value)
                  : ["answers", "draft"].includes(field)
                    ? (() => {
                        throw new CliError("invalidInput");
                      })()
                    : value;
          }
      }
      if (spec.required.some((key) => !(key in args))) throw new CliError("invalidInput");
      result = await client.execute(spec.id, args);
    }
    io.output.write(json ? JSON.stringify(result) + "\n" : cliOutput(result));
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : "unavailable";
    io.error.write(
      json ? JSON.stringify({ schema: 1, error: { code } }) + "\n" : "Panda: " + cliErrorText[code] + "\n",
    );
    return code === "authenticationRequired"
      ? 3
      : code === "forbidden"
        ? 4
        : code === "invalidInput" || code === "notFound"
          ? 2
          : code === "conflict" || code === "indexChanged"
            ? 5
            : code === "limit"
              ? 6
              : code === "configuration" || code === "notReady"
                ? 7
                : 1;
  }
}
