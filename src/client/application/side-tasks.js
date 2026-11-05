import { setMessageHtml, setOpaqueText } from "../i18n.js";

import { codexIcon } from "../codex-icons.js";

// Projects child-task activity and owns deferred side-task rendering.
export function assembleSideTasks({ renderBatch, mutations, state, $, escapeHtml, navigationPort }) {
  let pendingSideTasksRender = false;
  function sideTaskStatus(item, threadId) {
    const agent = item.agentsStates?.[threadId];
    if (agent?.status) return agent.status;
    if (item.type === "subAgentActivity") return item.kind === "interrupted" ? "interrupted" : "running";
    return item.status === "failed" ? "errored" : item.status === "completed" ? "completed" : "running";
  }
  function updateSideTasks(item) {
    if (item.type === "collabAgentToolCall") {
      for (const threadId of item.receiverThreadIds || []) {
        const previous = state.sideTasks.get(threadId) || {};
        mutations.collection("sideTasks").set(threadId, {
          ...previous,
          threadId,
          prompt: item.prompt || previous.prompt || "",
          model: item.model || previous.model || "",
          reasoningEffort: item.reasoningEffort || previous.reasoningEffort || "",
          status: sideTaskStatus(item, threadId),
          message: item.agentsStates?.[threadId]?.message || previous.message || "",
        });
      }
    } else if (item.type === "subAgentActivity") {
      const previous = state.sideTasks.get(item.agentThreadId) || {};
      mutations.collection("sideTasks").set(item.agentThreadId, {
        ...previous,
        threadId: item.agentThreadId,
        agentPath: item.agentPath || previous.agentPath || "",
        status: sideTaskStatus(item, item.agentThreadId),
      });
    }
    renderSideTasks();
  }
  function renderSideTasks() {
    if (renderBatch.active) {
      pendingSideTasksRender = true;
      return;
    }
    const list = $("#sideTaskList");
    if (!list) return;
    setMessageHtml(list, "");
    for (const task of state.sideTasks.values()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "side-task-card";
      button.dataset.threadId = task.threadId;
      setMessageHtml(
        button,
        `${codexIcon("messageSquare")}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath || task.model || "Side task")}</strong><small>${escapeHtml(task.message || task.prompt || task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status || "running")}">${escapeHtml(task.status || "running")}</span>`,
      );
      button.onclick = async () => {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        await navigationPort.openThread(task.threadId, {
          id: task.threadId,
          name: task.agentPath || task.model || "Side task",
          preview: task.prompt || task.message || "",
          cwd: state.active?.cwd || state.config.defaultCwd,
          source: "local",
          sideTask: true,
        });
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      };
      list.append(button);
    }
    if (!state.sideTasks.size)
      setMessageHtml(
        list,
        '<div class="side-task-empty"><span data-pf-message="common.sideTasksStartedByThisChatWillAppearHere">Side tasks started by this chat will appear here.</span></div>',
      );
    const summary = $("#summarySideTasks");
    if (summary)
      setOpaqueText(
        summary,
        state.sideTasks.size
          ? `${state.sideTasks.size} side task${state.sideTasks.size === 1 ? "" : "s"}`
          : "No side tasks",
      );
  }
  return {
    renderSideTasks,
    flush() {
      if (pendingSideTasksRender) {
        pendingSideTasksRender = false;
        renderSideTasks();
      }
    },
    updateSideTasks,
  };
}
