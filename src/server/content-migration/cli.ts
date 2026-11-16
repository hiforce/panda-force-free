import { planLegacyProjectCutover } from "./plan.js";
import { ProjectContentError } from "../project-content/errors.js";

/** The runtime image includes this data-only command; no HTTP server, engine, credential loader or publisher starts. */
export async function documentStoragePlanCommand(
  args: string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    write(
      "Usage: bun src/server/content-migration/cli.ts plan --backup ABSOLUTE_SQLITE_BACKUP --project PROJECT_ID [--assets ABSOLUTE_LEGACY_ASSET_ROOT]\nRead-only inventory; does not activate storage or publish content. Exit 2 reports migration blockers.\n",
    );
    return 0;
  }
  try {
    if (args[0] !== "plan" || args.length % 2 !== 1) throw new ProjectContentError("invalidFile");
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const name = args[i]!,
        value = args[i + 1]!;
      if (!["--backup", "--project", "--assets"].includes(name) || values.has(name) || !value || value.startsWith("--"))
        throw new ProjectContentError("invalidFile");
      values.set(name, value);
    }
    if (!values.has("--backup") || !values.has("--project")) throw new ProjectContentError("invalidFile");
    const plan = await planLegacyProjectCutover({
      backup: values.get("--backup")!,
      projectId: values.get("--project")!,
      assets: values.get("--assets"),
    });
    write(JSON.stringify(plan, null, 2) + "\n");
    return plan.status === "blocked" ? 2 : 0;
  } catch (error) {
    write(
      JSON.stringify({
        schema: 1,
        status: "error",
        code: error instanceof ProjectContentError ? error.code : "unavailable",
        storageActivated: false,
      }) + "\n",
    );
    return 1;
  }
}
if (import.meta.main) process.exitCode = await documentStoragePlanCommand(process.argv.slice(2));
