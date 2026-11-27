import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { MemoryTeamPreview, MemoryTeamView } from "../../shared/project-memory/contracts.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { confirmAction } from "../confirmation-dialog.js";
import type { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";

export function mountProjectTeamMemory(
  panel: HTMLElement,
  records: HTMLElement,
  project: string,
  t: Translate,
  request: ReturnType<typeof harnessApi>,
  closeSignal: AbortSignal,
) {
  const m = (id: MessageId) => messageHtml(id, {}, t);
  const endpoint = "/api/projects/" + encodeURIComponent(project) + "/memory-team";
  setMessageHtml(
    panel,
    `<header><h3 tabindex="-1">${m("projects.memoryTeamTitle")}</h3></header>
    <p data-memory-team-status role="status"></p>
    <div data-memory-team-results></div>
    <button type="button" class="wb-button" data-memory-team-retry hidden>${m("common.retry")}</button>`,
  );
  const status = panel.querySelector<HTMLElement>("[data-memory-team-status]")!;
  const results = panel.querySelector<HTMLElement>("[data-memory-team-results]")!;
  const retry = panel.querySelector<HTMLButtonElement>("[data-memory-team-retry]")!;
  let current: MemoryTeamView | undefined;
  let requestVersion = 0;
  let acting = false;
  let query = "";
  let focusEntry = new URLSearchParams(location.search).get("shared");
  const scopeLink = (id: MessageId) => messageAttributes("aria-label", id, {}, t);

  function draw() {
    records.dataset.teamCanPublish = String(current?.canPublish === true);
    const search = query.trim().toLocaleLowerCase();
    const entries =
      current?.entries.filter(
        (entry) =>
          entry.value !== null &&
          (!search ||
            [entry.key, entry.scope, entry.value].some((value) => value.toLocaleLowerCase().includes(search))),
      ) ?? [];
    const available = entries
      .map(
        (entry) =>
          `<li data-team-entry="${escape(entry.id)}" tabindex="-1"><div><strong data-i18n-ignore>${escape(entry.key)}</strong>
      <small data-i18n-ignore>${escape(entry.scope)}</small></div>
      <code data-i18n-ignore>${escape(entry.value ?? "")}</code></li>`,
      )
      .join("");
    const own = current?.publications
      .map(
        (share) =>
          `<li><div><strong data-i18n-ignore>${escape(share.key)}</strong> <small data-i18n-ignore>${escape(share.scope)}</small>
      ${share.active ? "" : `<span>${m("projects.memoryTeamInactive")}</span>`}</div>
      <button type="button" class="wb-button memory-team-action" data-memory-team-withdraw="${escape(share.entryId)}"
        ${scopeLink("projects.memoryTeamWithdraw")} ${messageAttributes("data-tooltip", "projects.memoryTeamWithdraw", {}, t)}>
        ${codexIcon("x")}<span class="memory-team-action-label">${m("projects.memoryTeamWithdraw")}</span>
      </button></li>`,
      )
      .join("");
    setMessageHtml(
      results,
      (available ? `<ul class="memory-team-entries">${available}</ul>` : `<p>${m("projects.memoryTeamEmpty")}</p>`) +
        (own
          ? `<details data-memory-team-own><summary>${m("projects.memoryTeamManage")}</summary><ul class="memory-team-entries">${own}</ul></details>`
          : ""),
    );
    for (const button of results.querySelectorAll<HTMLButtonElement>("[data-memory-team-withdraw]"))
      button.onclick = () => void withdraw(button);
    if (focusEntry && /^[a-f0-9]{64}$/u.test(focusEntry)) {
      const target = results.querySelector<HTMLElement>(`[data-team-entry="${focusEntry}"]`);
      if (target) target.focus();
      else status.textContent = t("projects.memoryTeamUnavailable");
      focusEntry = null;
    }
  }

  async function refresh(next = query) {
    query = next;
    if (closeSignal.aborted) return;
    const version = ++requestVersion;
    retry.hidden = true;
    if (!current) status.textContent = t("common.pageLoading");
    try {
      const data = await request<MemoryTeamView>(endpoint, "GET", undefined, closeSignal);
      if (closeSignal.aborted || version !== requestVersion) return;
      const ownOpen = results.querySelector<HTMLDetailsElement>("[data-memory-team-own]")?.open;
      current = data;
      status.textContent = "";
      draw();
      if (ownOpen) {
        const detail = results.querySelector<HTMLDetailsElement>("[data-memory-team-own]");
        if (detail) detail.open = true;
      }
    } catch (error) {
      if (closeSignal.aborted || version !== requestVersion) return;
      current = undefined;
      results.replaceChildren();
      records.dataset.teamCanPublish = "false";
      status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      retry.hidden = false;
    }
  }
  retry.onclick = () => void refresh();

  async function transact(button: HTMLButtonElement, work: () => Promise<void>) {
    if (acting || closeSignal.aborted) return;
    acting = button.disabled = true;
    try {
      await work();
    } catch (error) {
      if (!closeSignal.aborted)
        status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      acting = button.disabled = false;
    }
  }

  async function publish(entryId: string, button: HTMLButtonElement) {
    if (!current?.canPublish) return;
    await transact(button, async () => {
      const preview = await request<MemoryTeamPreview>(
        endpoint + "/" + entryId,
        "POST",
        { action: "preview" },
        closeSignal,
      );
      if (closeSignal.aborted) return;
      const values = { key: preview.key, scope: preview.scope, value: preview.value };
      const accepted = await confirmAction({
        title: "projects.memoryTeamPublish",
        message: "projects.memoryTeamPreviewHint",
        detailMessage: "projects.memoryTeamPreviewDetail",
        detailValues: values,
        confirmText: "projects.memoryTeamPublish",
        confirmTone: "primary",
        cancelText: "common.cancel",
        returnFocus: button,
      });
      if (!accepted || closeSignal.aborted) {
        if (button.isConnected) {
          button.disabled = false;
          button.focus({ preventScroll: true });
        }
        return;
      }
      await request(endpoint + "/" + entryId, "POST", { action: "publish", token: preview.token }, closeSignal);
      await refresh();
      if (!closeSignal.aborted) status.textContent = t("projects.memoryTeamPublished");
      if (button.isConnected) {
        button.disabled = false;
        button.focus({ preventScroll: true });
      }
    });
  }

  async function withdraw(button: HTMLButtonElement) {
    const publication = current?.publications.find((item) => item.entryId === button.dataset.memoryTeamWithdraw);
    if (!publication) return;
    await transact(button, async () => {
      await request(
        endpoint + "/" + publication.entryId,
        "POST",
        { action: "withdraw", revision: publication.revision },
        closeSignal,
      );
      await refresh();
      if (!closeSignal.aborted) {
        status.textContent = t("projects.memoryTeamWithdrawn");
        (results.querySelector<HTMLElement>("[data-memory-team-own] summary") ?? panel.querySelector("h3"))?.focus({
          preventScroll: true,
        });
      }
    });
  }

  return { refresh, publish };
}
