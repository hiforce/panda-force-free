// One catalog owns suggestion metadata and dispatch classification.
const commands = [
  {
    id: "goal",
    kind: "goal",
    title: "composer.commandGoalTitle",
    description: "composer.commandGoalDescription",
    icon: "target",
    requiresThread: true,
  },
  {
    id: "review",
    kind: "native",
    title: "composer.commandReviewTitle",
    description: "composer.commandReviewDescription",
    icon: "fileDiff",
    requiresThread: true,
  },
  {
    id: "fork",
    kind: "native",
    title: "composer.commandForkTitle",
    description: "composer.commandForkDescription",
    icon: "gitBranch",
    requiresThread: true,
  },
  {
    id: "model",
    kind: "local",
    title: "composer.commandModelTitle",
    description: "composer.commandModelDescription",
    icon: "slidersHorizontal",
  },
  {
    id: "plan",
    kind: "local",
    title: "composer.commandPlanTitle",
    description: "composer.commandPlanDescription",
    icon: "list",
  },
  {
    id: "project",
    kind: "local",
    title: "composer.commandProjectTitle",
    description: "composer.commandProjectDescription",
    icon: "folderOpen",
  },
  {
    id: "reasoning",
    kind: "local",
    title: "composer.commandReasoningTitle",
    description: "composer.commandReasoningDescription",
    icon: "slidersHorizontal",
  },
  {
    id: "init",
    kind: "local",
    title: "composer.commandInitTitle",
    description: "composer.commandInitDescription",
    icon: "file",
  },
  {
    id: "mcp",
    kind: "local",
    title: "composer.commandMcpTitle",
    description: "composer.commandMcpDescription",
    icon: "plug",
  },
  {
    id: "compact",
    kind: "native",
    title: "composer.commandCompactTitle",
    description: "composer.commandCompactDescription",
    icon: "list",
    requiresThread: true,
  },
  {
    id: "side",
    kind: "native",
    title: "composer.commandSideTitle",
    description: "composer.commandSideDescription",
    icon: "messageSquare",
    requiresThread: true,
  },
  {
    id: "fast",
    kind: "native",
    title: "composer.commandFastTitle",
    description: "composer.commandFastDescription",
    icon: "loaderCircle",
    requiresThread: true,
  },
  {
    id: "feedback",
    kind: "native",
    title: "composer.commandFeedbackTitle",
    description: "composer.commandFeedbackDescription",
    icon: "messageSquare",
    requiresThread: true,
  },
  {
    id: "status",
    kind: "local",
    title: "composer.commandStatusTitle",
    description: "composer.commandStatusDescription",
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
