import { codexIcon } from "../codex-icons.js";
import { botTaskState, botTaskDecision } from "../../shared/bots/task-state.js";
import type { BotQueueSnapshot } from "../../shared/bots/contracts.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { botUi, botDate, taskStateIds, type BotContext } from "./ui.js";
import { botAvatarHtml } from "./avatar.js";
import { openBotTask, deleteBotRecord } from "./task-detail.js";

const groups: [string, MessageId][] = [
  ["", "cli.botAllTasks"],
  ["attention", "cli.botAttention"],
  ["progress", "cli.botPendingExecution"],
  ["completed", "cli.botCompleted"],
];
export function createBotTaskList(context: BotContext) {
  let host: HTMLElement | null = null,
    snapshot: BotQueueSnapshot,
    query = "",
    filter = "",
    botId = "",
    fingerprint = "",
    page = 1,
    anchor = 0,
    requestVersion = 0,
    limit = 50,
    searchTimer: ReturnType<typeof setTimeout> | null = null;
  const { h, attributes, option, button, icon, badge, outcome, empty } = botUi(context.t);
  const reload = () => {
    const current = ++requestVersion;
    host?.setAttribute("aria-busy", "true");
    void context
      .reload(true)
      .catch(() => {
        if (current === requestVersion) context.notice(context.t("cli.botLoadFailed"));
      })
      .finally(() => {
        if (current === requestVersion) host?.removeAttribute("aria-busy");
      });
  };
  const changed = () => {
    page = 1;
    anchor = 0;
    reload();
  };
  function rows() {
    if (!host) return;
    const list = host.querySelector<HTMLElement>("[data-bot-task-rows]")!,
      tasks = snapshot.tasks,
      focused = list.querySelector<HTMLButtonElement>(":focus"),
      focusedId = focused?.dataset.detail ?? focused?.dataset.deleteRecord,
      focusedAction = focused?.hasAttribute("data-delete-record") ? "delete-record" : "detail";
    host
      .querySelectorAll<HTMLButtonElement>("[data-queue-filter]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.queueFilter === filter)));
    setMessageHtml(
      list,
      tasks.length
        ? tasks
            .map(
              (task) =>
                `<article class="bot-task-row" data-task-id="${e(task.id)}" data-decision="${botTaskDecision(task) || "pending"}"><div class="bot-task-copy"><strong data-i18n-ignore title="${e(task.title || task.summary || task.externalTaskId)}">${e(task.title || task.summary || task.externalTaskId)}</strong><small data-i18n-ignore title="${e(task.externalTaskId)}"><code>${e(task.externalTaskId.length > 42 ? task.externalTaskId.slice(0, 22) + "…" + task.externalTaskId.slice(-12) : task.externalTaskId)}</code></small></div><span class="bot-task-agent">${botAvatarHtml(snapshot.bots.find((b) => b.id === task.botId))}<span data-i18n-ignore>${e(snapshot.bots.find((b) => b.id === task.botId)?.name ?? "—")}</span></span>${badge(task)}${outcome(task)}<time datetime="${new Date(task.updatedAt).toISOString()}">${e(botDate(task.updatedAt))}</time><div class="bot-record-actions"><button type="button" class="wb-button bot-row-open" data-detail="${e(task.id)}" ${attributes("aria-label", "cli.botDetails")} ${attributes("title", "cli.botDetails")}>${icon("arrowUpRight")}</button><button type="button" class="wb-button bot-row-delete" data-delete-record="${e(task.id)}" ${task.status === "running" ? "disabled" : ""} ${attributes("aria-label", "cli.botDeleteRecord")} ${attributes("title", "cli.botDeleteRecord")}>${icon("trash")}</button></div></article>`,
            )
            .join("")
        : empty(
            (snapshot.total ?? snapshot.tasks.length) || query || filter || botId ? "cli.botNoMatches" : "cli.botEmpty",
            (snapshot.total ?? snapshot.tasks.length) || query || filter || botId
              ? "cli.botNoMatchesHint"
              : "cli.botEmptyHint",
            (snapshot.total ?? snapshot.tasks.length) || query || filter || botId
              ? button("cli.botReset", "data-reset-filters")
              : `<a class="wb-button" href="/settings/bots" data-wb="route" data-route="/settings/bots">${h("cli.botManageLink")}</a>`,
          ),
    );
    list.querySelectorAll<HTMLButtonElement>("[data-detail]").forEach(
      (b) =>
        (b.onclick = () =>
          void context.execute(async () => {
            b.disabled = true;
            try {
              if (host) await openBotTask(host.parentElement!, context, b.dataset.detail!, b);
            } finally {
              b.disabled = false;
            }
          })),
    );
    list.querySelectorAll<HTMLButtonElement>("[data-delete-record]").forEach(
      (b) =>
        (b.onclick = () => {
          b.disabled = true;
          void deleteBotRecord(context, b.dataset.deleteRecord!).finally(() => {
            b.disabled = false;
          });
        }),
    );
    list.querySelector<HTMLButtonElement>("[data-reset-filters]")?.addEventListener("click", () => {
      query = filter = botId = "";
      host!.querySelector<HTMLInputElement>("[data-bot-search]")!.value = "";
      host!.querySelector<HTMLSelectElement>("[data-filter]")!.value = "";
      host!.querySelector<HTMLSelectElement>("[data-bot-select]")!.value = "";
      changed();
    });
    if (focusedId) {
      const previous = list.querySelector<HTMLButtonElement>(`[data-${focusedAction}="${CSS.escape(focusedId)}"]`);
      const target = previous && !previous.disabled ? previous : list.querySelector<HTMLButtonElement>("[data-detail]");
      target?.focus({ preventScroll: true });
    }
  }
  return {
    queryString() {
      return new URLSearchParams({
        page: String(page),
        anchor: String(page > 1 ? anchor : 0),
        limit: String(limit),
        filter,
        bot: botId,
        q: query,
      }).toString();
    },
    render(element: HTMLElement, value: BotQueueSnapshot) {
      snapshot = value;
      if (host !== element || !element.querySelector("[data-bot-task-rows]")) {
        host = element;
        fingerprint = "";
        setMessageHtml(
          host,
          `<div class="bot-metrics" role="group" ${attributes("aria-label", "cli.botTaskFilter")}>${groups.map(([key, label]) => `<button type="button" data-queue-filter="${key}" aria-pressed="${filter === key}"><span>${h(label)}</span><strong data-bot-count="${key}">0</strong>${icon(key === "attention" ? "circleHelp" : key === "progress" ? "play" : key === "completed" ? "check" : "list")}</button>`).join("")}</div><div class="bot-task-filters wb-form"><label class="wb-field bot-search-field"><span class="bot-filter-caption">${h("cli.botSearch")}</span><span class="wb-control-with-icon">${codexIcon("search")}<input type="search" data-bot-search autocomplete="off" maxlength="160" ${attributes("placeholder", "cli.botSearchPlaceholder")}></span></label><label class="wb-field"><span class="bot-filter-caption">${h("cli.botSelect")}</span><select data-bot-select></select></label><label class="wb-field"><span class="bot-filter-caption">${h("cli.botStatus")}</span><select data-filter>${option("", "cli.botAll")}${groups
            .slice(1)
            .concat(Object.entries(taskStateIds) as [string, MessageId][])
            .map(([key, label]) => option(key, label))
            .join(
              "",
            )}</select></label></div><div class="bot-task-table"><div class="bot-task-columns" aria-hidden="true"><span>${h("cli.botTaskColumn")}</span><span>${h("cli.botSelect")}</span><span>${h("cli.botStatus")}</span><span>${h("cli.botResult")}</span><span>${h("cli.botUpdated")}</span><span></span></div><div class="bot-task-list" data-bot-task-rows></div></div><footer class="bot-pagination"><span data-page-summary aria-live="polite"></span><div><label class="bot-page-size"><span>${h("cli.botPageSize")}</span><select data-page-size aria-label="${e(context.t("cli.botPageSize"))}">${[25, 50, 100].map((n) => `<option value="${n}" ${n === limit ? "selected" : ""}>${n}</option>`).join("")}</select></label>${button("cli.botPreviousPage", "data-page-prev", false, "chevronLeft")}${button("cli.botNextPage", "data-page-next", false, "chevronRight")}</div></footer>`,
        );
        host.querySelector<HTMLInputElement>("[data-bot-search]")!.value = query;
        host.querySelector<HTMLInputElement>("[data-bot-search]")!.oninput = (event) => {
          query = (event.target as HTMLInputElement).value;
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(changed, 300);
        };
        host.querySelector<HTMLSelectElement>("[data-filter]")!.value = filter;
        host.querySelector<HTMLSelectElement>("[data-filter]")!.onchange = (event) => {
          filter = (event.target as HTMLSelectElement).value;
          changed();
        };
        host.querySelector<HTMLSelectElement>("[data-bot-select]")!.onchange = (event) => {
          botId = (event.target as HTMLSelectElement).value;
          changed();
        };
        host.querySelectorAll<HTMLButtonElement>("[data-queue-filter]").forEach(
          (b) =>
            (b.onclick = () => {
              filter = b.dataset.queueFilter!;
              host!.querySelector<HTMLSelectElement>("[data-filter]")!.value = filter;
              changed();
            }),
        );
      }
      page = value.page ?? page;
      anchor = value.anchor ?? anchor;
      const total = value.total ?? value.tasks.length;
      host.querySelector<HTMLElement>("[data-page-summary]")!.textContent = context.t("cli.botPageSummary", {
        start: String(total ? (page - 1) * limit + 1 : 0),
        end: String(Math.min(page * limit, total)),
        total: String(total),
      });
      const prev = host.querySelector<HTMLButtonElement>("[data-page-prev]")!,
        nextButton = host.querySelector<HTMLButtonElement>("[data-page-next]")!;
      prev.disabled = page <= 1;
      nextButton.disabled = page * limit >= total;
      prev.onclick = () => {
        page--;
        reload();
      };
      nextButton.onclick = () => {
        page++;
        reload();
      };
      host.querySelector<HTMLSelectElement>("[data-page-size]")!.onchange = (event) => {
        limit = Number((event.target as HTMLSelectElement).value);
        changed();
      };
      const next = JSON.stringify(value);
      if (next === fingerprint) return;
      fingerprint = next;
      const counts =
        value.counts ??
        Object.fromEntries(
          ["created", "running", "finished", "suspended", "canceled", "error"].map((state) => [
            state,
            value.tasks.filter((task) => botTaskState(task) === state).length,
          ]),
        );
      for (const item of host.querySelectorAll<HTMLElement>("[data-bot-count]")) {
        const key = item.dataset.botCount!,
          keys =
            key === "attention"
              ? ["suspended", "error"]
              : key === "progress"
                ? ["created", "running"]
                : key === "completed"
                  ? ["finished"]
                  : Object.keys(counts);
        item.textContent = String(keys.reduce((n, k) => n + (counts[k] ?? 0), 0));
      }
      const select = host.querySelector<HTMLSelectElement>("[data-bot-select]")!;
      setMessageHtml(
        select,
        `${option("", "cli.botAllBots")}${value.bots.map((bot) => `<option value="${e(bot.id)}">${e(bot.name)}</option>`).join("")}`,
      );
      select.value = botId;
      rows();
    },
    hide() {
      if (searchTimer) clearTimeout(searchTimer);
      requestVersion++;
      host = null;
      fingerprint = "";
    },
  };
}
