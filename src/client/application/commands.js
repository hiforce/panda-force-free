import { parseSlashCommand } from "./command-catalog.js";
// Dispatches explicit local, native and Goal commands without owning composer drafts.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "sessions" | "state" | "$" | "t", "sessionWorkspace" | "transport" | "composer" | "models" | "workspace" | "notices" | "navigation" | "goals", "commands">} options */
export function assembleCommands({
  transportPort,
  viewUpdates,
  sessions,
  state,
  $,
  t,
  composerPort,
  modelsPort,
  workspacePort,
  noticesPort,
  navigationPort,
  goalsPort,
  sessionWorkspacePort,
}) {
  function parseGoalCommand(text) {
    const match = String(text || "")
      .trim()
      .match(/^\/goal(?:\s+(.*))?$/is);
    if (!match) return null;
    const value = (match[1] || "").trim(),
      command = value.toLowerCase();
    return {
      command: ["pause", "resume", "clear"].includes(command) ? command : "set",
      objective: ["pause", "resume", "clear"].includes(command) ? "" : value,
    };
  }
  const parseNativeSlashCommand = (text) => parseSlashCommand(text, "native");
  const parseLocalSlashCommand = (text) => parseSlashCommand(text, "local");
  function handleLocalSlashCommand(command) {
    if (command === "plan") {
      composerPort.setPlanMode(!state.planMode);
      $("#prompt").value = "";
      viewUpdates.request("composerLayout");
    } else if (command === "model") {
      if (state.active?.id) sessionWorkspacePort.openSettings("model");
      else modelsPort.openModelMenu();
    } else if (command === "reasoning") {
      if (state.active?.id) sessionWorkspacePort.openSettings("model");
      else modelsPort.openModelMenu();
    } else if (command === "project") {
      workspacePort.openFolderPicker();
    } else if (command === "status") {
      noticesPort.toast(
        state.active?.id ? t("composer.taskIdentity", { id: state.active.id }) : t("composer.noActiveTask"),
      );
    } else if (command === "init") {
      noticesPort.toast(t("composer.initBridgeRequired"));
    } else if (command === "mcp") {
      noticesPort.toast(t("composer.mcpSurfaceRequired"));
    }
  }
  async function submitNativeSlashCommand(thread, command) {
    if (!thread?.id) {
      noticesPort.toast(t("workbench.startATaskFirst"));
      return;
    }
    if (command === "compact") {
      await transportPort.rpc("thread/compact/start", { threadId: thread.id });
      noticesPort.toast(t("composer.compactionStarted"));
      return;
    }
    if (command === "review") {
      await transportPort.rpc("review/start", {
        threadId: thread.id,
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
      noticesPort.toast(t("composer.reviewStarted"));
      return;
    }
    if (command === "fork") {
      const result = await transportPort.rpc("thread/fork", { threadId: thread.id, excludeTurns: true });
      if (result?.thread?.id) {
        sessions.addSummary(result.thread);
        await navigationPort.openThread(result.thread.id);
      }
      return;
    }
    noticesPort.toast(
      command === "side"
        ? "Side tasks require the native side-task bridge"
        : command === "fast"
          ? "Fast mode requires native model controls"
          : "Feedback requires the native feedback bridge",
    );
  }

  return {
    submitGoalCommand: /** @param {Parameters<typeof goalsPort.submitGoalCommand>} args */ (...args) =>
      goalsPort.submitGoalCommand(...args),
    submitNativeSlashCommand,
    parseGoalCommand,
    parseNativeSlashCommand,
    parseLocalSlashCommand,
    handleLocalSlashCommand,
  };
}
