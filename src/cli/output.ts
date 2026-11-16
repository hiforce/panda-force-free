import type { CliErrorCode } from "../shared/cli/contracts.js";
const clean = (value: unknown) => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
function table(columns: string[], rows: unknown[][]) {
  const values = [columns, ...rows].map((row) => row.map(clean));
  const width = (text: string) =>
    [...text].reduce(
      (size, char) =>
        size +
        (/\p{Mark}/u.test(char)
          ? 0
          : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
            ? 2
            : 1),
      0,
    );
  const widths = columns.map((_, index) => Math.max(...values.map((row) => width(row[index] || ""))));
  return (
    values
      .map((row) =>
        row
          .map((cell, index) => cell + " ".repeat(widths[index]! - width(cell)))
          .join("  ")
          .trimEnd(),
      )
      .join("\n") + "\n"
  );
}
/** Human formatting never changes the versioned JSON results consumed by agents and scripts. */
export function cliOutput(result: unknown) {
  const envelope = result as Record<string, unknown>,
    data = (envelope.data || envelope) as Record<string, unknown>;
  for (const [field, columns] of Object.entries({
    documents: ["id", "title", "version"],
    spaces: ["id", "name", "version"],
    tasks: ["id", "title", "state"],
    profiles: ["name", "server", "kind"],
    hits: ["id", "title", "score"],
  })) {
    if (!Array.isArray(data[field])) continue;
    const rows = data[field] as Record<string, unknown>[];
    const next = data.nextOffset ?? data.nextCursor;
    return (
      (rows.length
        ? table(
            columns,
            rows.map((row) => columns.map((column) => row[column])),
          )
        : "No results.\n") + (next !== undefined && next !== null ? "Next page: " + clean(next) + "\n" : "")
    );
  }
  if (Array.isArray(envelope.commands) && typeof envelope.version === "string") {
    const commands = envelope.commands as { words: string[]; summary: string }[];
    return (
      `Panda CLI ${clean(envelope.version)} · Protocol 1\n\nUsage: panda COMMAND [--profile NAME] [--json] [--timeout SECONDS]\nRegister a client and configure its API key before reading content.\n\n` +
      table(
        ["Command", "Purpose"],
        commands.map((command) => [command.words.join(" "), command.summary]),
      ) +
      "\nSetup: register, auth login/status/profiles/use/logout, doctor\nIntegration: integrations install/inspect/uninstall, mcp serve\nReference: panda guide --json or panda guide --format html\n"
    );
  }
  return JSON.stringify(result, null, 2) + "\n";
}
export const cliErrorText: Record<CliErrorCode, string> = {
  invalidInput: "Check the command and arguments. Run panda help for usage.",
  authenticationRequired: "A registered profile and a valid API key are required.",
  forbidden: "This client does not have permission for that scope or operation.",
  notFound: "The command or requested item was not found.",
  conflict: "The saved version or managed files changed. Inspect the current state before retrying.",
  limit: "A size or concurrency limit was reached. Check the input or retry later.",
  unavailable: "The service or local configuration is unavailable. Check panda doctor.",
  configuration: "Search is not configured for this mode. Check search settings in Panda.",
  notReady: "The search index is not ready. Check panda search status before querying again.",
  indexChanged: "The search index changed. Check panda search status before querying again.",
};
