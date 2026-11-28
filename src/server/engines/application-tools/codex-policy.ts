import type { ApplicationToolDefinition } from "../../../shared/engine/application-tools.js";

export const codexCreationToolNamespace = "panda_creation";

/** Per-thread policy leaves ordinary coding sessions and daemon configuration untouched. */
export function codexApplicationThread(
  cwd: string,
  instructions: string,
  tools: readonly ApplicationToolDefinition[],
  model?: string,
  namespace?: typeof codexCreationToolNamespace,
) {
  const functions = tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
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
      ...(namespace
        ? {
            // Keep task-owned callbacks directly callable when the chosen model uses Code Mode.
            "features.code_mode": { enabled: false, direct_only_tool_namespaces: [namespace] },
            "features.code_mode_only_strict_3p_tools": false,
          }
        : {}),
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
    dynamicTools: namespace
      ? [
          {
            type: "namespace",
            name: namespace,
            description: "Tools authorized for the current PandaForce creation.",
            tools: functions,
          },
        ]
      : functions,
  };
}
