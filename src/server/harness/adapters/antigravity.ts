import { HarnessError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { AcpSessionAgent, type AcpLaunchOptions } from "./acp-session.js";
import type { HarnessApplicationPolicy } from "../ports.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { allowsHarnessOutputWrite } from "../workspaces.js";
import { acpRecord } from "./acp.js";

export class AntigravityHarnessAgent extends AcpSessionAgent {
  constructor(
    launch: AcpLaunchOptions,
    permissionMode: HarnessPermissionMode = "ask",
    scoped?: { name: string; application: HarnessApplicationPolicy },
  ) {
    if (permissionMode !== "ask" && permissionMode !== "always-approve")
      throw new HarnessError("capabilityUnavailable", 409);
    const host = "socketPath" in launch;
    if (host && permissionMode !== "ask") throw new HarnessError("capabilityUnavailable", 409);
    super(launch, {
      args: scoped
        ? ["acp", "--sandbox", "--process-per-session", "--disable-telemetry", "--agent", scoped.name]
        : permissionMode === "always-approve"
          ? ["acp", "--dangerously-skip-permissions"]
          : ["acp"],
      effortId: "thought_level",
      permissionMode,
      permissionModes: host ? ["ask"] : ["ask", "always-approve"],
      ...(scoped
        ? {
            application: scoped.application,
            applicationTransport: "http",
            allowApplicationTool: async (tool: Record<string, unknown>) => {
              if (scoped.application.nativeOutput && tool.kind === "edit" && tool.name === "write_file")
                return allowsHarnessOutputWrite(launch.cwd, acpRecord(tool.rawInput).Path);
              const prefix = "mcp_" + scoped.application.mcpServer.name + "_";
              return (
                tool.kind === "other" &&
                typeof tool.name === "string" &&
                tool.title === "Run " + tool.name &&
                (scoped.application.toolNames ?? []).some((name) => tool.name === prefix + name)
              );
            },
          }
        : {}),
    });
  }
}

export async function antigravityApplicationAgent(
  launch: Extract<AcpLaunchOptions, { command: string }>,
  application: HarnessApplicationPolicy,
) {
  const name = "panda-application-" + randomUUID();
  const agents = join(launch.cwd, ".agents", "agents");
  await mkdir(agents, { recursive: true, mode: 0o700 });
  const config = {
    name,
    description: "PandaForce scoped task",
    tools: application.nativeOutput ? ["send_message", "write_file"] : ["send_message"],
    mainAgent: true,
    subagent: false,
    inheritCustomizations: false,
    inheritMcp: false,
    commandExecutionPolicy: "off",
  };
  const frontmatter = Object.entries(config).map(([key, value]) => key + ": " + JSON.stringify(value));
  await writeFile(join(agents, name + ".md"), ["---", ...frontmatter, "---", application.instructions].join("\n"), {
    mode: 0o600,
  });
  return new AntigravityHarnessAgent(launch, "ask", { name, application });
}
