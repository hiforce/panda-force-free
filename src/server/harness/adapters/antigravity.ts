import { HarnessError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { AcpSessionAgent, type AcpLaunchOptions } from "./acp-session.js";

export class AntigravityHarnessAgent extends AcpSessionAgent {
  constructor(launch: AcpLaunchOptions, permissionMode: HarnessPermissionMode = "ask") {
    if (permissionMode !== "ask" && permissionMode !== "always-approve")
      throw new HarnessError("capabilityUnavailable", 409);
    const host = "socketPath" in launch;
    if (host && permissionMode !== "ask") throw new HarnessError("capabilityUnavailable", 409);
    super(launch, {
      args: permissionMode === "always-approve" ? ["acp", "--dangerously-skip-permissions"] : ["acp"],
      effortId: "thought_level",
      permissionMode,
      permissionModes: host ? ["ask"] : ["ask", "always-approve"],
    });
  }
}
