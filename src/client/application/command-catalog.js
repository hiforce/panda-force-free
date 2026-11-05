// One catalog owns suggestion metadata and dispatch classification.
const commands = [
  {
    id: "goal",
    kind: "goal",
    title: "Goal",
    description: "Create or manage a persistent Goal",
    icon: "target",
    requiresThread: true,
  },
  {
    id: "review",
    kind: "native",
    title: "Review",
    description: "Review uncommitted changes",
    icon: "fileDiff",
    requiresThread: true,
  },
  {
    id: "fork",
    kind: "native",
    title: "Fork",
    description: "Create a new task from this history",
    icon: "gitBranch",
    requiresThread: true,
  },
  {
    id: "model",
    kind: "local",
    title: "Model",
    description: "Choose model and reasoning effort",
    icon: "wrench",
  },
  {
    id: "plan",
    kind: "local",
    title: "Plan mode",
    description: "Turn plan mode on",
    icon: "list",
  },
  {
    id: "project",
    kind: "local",
    title: "Project",
    description: "Choose project for new tasks",
    icon: "folderOpen",
  },
  {
    id: "reasoning",
    kind: "local",
    title: "Reasoning",
    description: "Choose reasoning effort",
    icon: "wrench",
  },
  {
    id: "init",
    kind: "local",
    title: "Init",
    description: "Create an AGENTS.md file with instructions for Codex",
    icon: "file",
  },
  {
    id: "mcp",
    kind: "local",
    title: "MCP",
    description: "Show MCP server status",
    icon: "wrench",
  },
  {
    id: "compact",
    kind: "native",
    title: "Compact",
    description: "Compact this task's context",
    icon: "list",
    requiresThread: true,
  },
  {
    id: "side",
    kind: "native",
    title: "Side",
    description: "Open a side task",
    icon: "messageSquare",
    requiresThread: true,
  },
  {
    id: "fast",
    kind: "native",
    title: "Fast",
    description: "Switch execution speed when supported",
    icon: "loaderCircle",
    requiresThread: true,
  },
  {
    id: "feedback",
    kind: "native",
    title: "Feedback",
    description: "Send product feedback",
    icon: "messageSquare",
    requiresThread: true,
  },
  {
    id: "status",
    kind: "local",
    title: "Status",
    description: "Show task id, context usage, and rate limits",
    icon: "info",
    requiresThread: true,
  },
];
export const slashCommandCatalog = Object.freeze(commands.map((command) => Object.freeze(command)));
export function parseSlashCommand(text, kind) {
  const value = String(text || "")
    .trim()
    .toLowerCase();
  return slashCommandCatalog.find((command) => command.kind === kind && "/" + command.id === value)?.id || null;
}
