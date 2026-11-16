import type { ApplicationToolDefinition } from "../../../shared/engine/application-tools.js";

/** Per-thread policy leaves ordinary coding sessions and daemon configuration untouched. */
export function codexApplicationThread(
  cwd: string,
  instructions: string,
  tools: readonly ApplicationToolDefinition[],
  model?: string,
) {
  return {
    cwd,
    model,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: instructions,
    config: {
      // Replace inherited MCP inventory for this thread without changing daemon or account configuration.
      mcp_servers: {},
      project_doc_max_bytes: 0,
      "skills.include_instructions": false,
      "skills.bundled.enabled": false,
      web_search: "disabled",
      ...Object.fromEntries(
        [
          "shell_tool",
          "apps",
          "plugins",
          "hooks",
          "multi_agent",
          "view_image",
          "image_generation",
          "browser_use",
          "browser_use_external",
          "computer_use",
          "goals",
          "sleep_tool",
          "skill_search",
          "skill_mcp_dependency_install",
          "tool_suggest",
          "remote_plugin",
          "workspace_dependencies",
          "memories",
          "code_mode_host",
          "shell_snapshot",
        ].map((name) => ["features." + name, false]),
      ),
    },
    dynamicTools: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}
