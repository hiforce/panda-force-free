import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { MemorySourceLocation } from "../../shared/project-memory/contracts.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { conversationHref, parseMemorySource } from "./memory-source-link.js";

export function createMemorySourceReader(t: Translate) {
  const api = harnessApi(t);
  let active: { host: HTMLElement; key: string; request: AbortController } | undefined;
  const m = (id: MessageId) => messageHtml(id, {}, t);

  function hide() {
    active?.request.abort();
    active = undefined;
  }

  function show(host: HTMLElement, url: URL, id: string) {
    const key = url.pathname + url.search;
    if (active?.host === host && active.key === key && host.querySelector(".memory-source-reader")) return;
    hide();
    const link = parseMemorySource(url, id);
    const request = new AbortController();
    active = { host, key, request };
    const back = link ? m("projects.memoryBackToProject") : m("common.projects");
    setMessageHtml(
      host,
      `<section class="project-overview memory-source-reader">
        <header class="memory-source-header">
          <a href="${escape(link?.back ?? "/projects")}" class="wb-button memory-source-back">${codexIcon("arrowLeft")}${back}</a>
          <a class="wb-button" data-memory-source-open href="${escape(link ? conversationHref(link.conversation) : "/tasks")}" hidden>${codexIcon("messageSquare")}${m("projects.memorySourceConversation")}</a>
        </header>
        <h1>${m("projects.memorySourcePosition")}</h1>
        <p data-memory-source-reader-status role="status"></p>
        <button type="button" class="wb-button" data-memory-source-retry hidden>${m("common.retry")}</button>
        <article class="memory-source-message" data-memory-original tabindex="-1" hidden>
          <header><h2 data-i18n-ignore></h2><time></time></header><div class="memory-source-body" data-i18n-ignore></div>
        </article>
      </section>`,
    );
    const status = host.querySelector<HTMLElement>("[data-memory-source-reader-status]")!;
    const retry = host.querySelector<HTMLButtonElement>("[data-memory-source-retry]")!;
    const message = host.querySelector<HTMLElement>("[data-memory-original]")!;
    const open = host.querySelector<HTMLAnchorElement>("[data-memory-source-open]")!;

    async function load() {
      if (request.signal.aborted) return;
      retry.hidden = true;
      message.hidden = true;
      open.hidden = true;
      if (!link) {
        status.textContent = t("projects.memoryTerrainEvidenceUnavailable");
        return;
      }
      status.textContent = t("common.pageLoading");
      try {
        const params = new URLSearchParams({
          conversation: link.conversation,
          message: link.message,
          view: "location",
        });
        const data = await api<MemorySourceLocation>(
          "/api/projects/" + encodeURIComponent(link.project) + "/memory-source?" + params,
          "GET",
          undefined,
          AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        );
        if (request.signal.aborted) return;
        if (data.message.id !== link.message) throw new Error();
        const heading = message.querySelector("h2")!;
        heading.hidden = !data.title || data.title === data.message.text;
        if (!heading.hidden) setOpaqueText(heading, data.title);
        const time = message.querySelector("time")!;
        const date = new Date(data.message.createdAt);
        time.dateTime = date.toISOString();
        time.textContent = new Intl.DateTimeFormat(document.documentElement.lang, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
        message.dataset.memoryMessageId = data.message.id;
        setOpaqueText(message.querySelector(".memory-source-body"), data.message.text);
        status.textContent = "";
        message.hidden = false;
        open.href = data.nativeConversationId
          ? "/task/" + encodeURIComponent(data.nativeConversationId)
          : conversationHref(link.conversation);
        open.hidden = false;
        message.focus({ preventScroll: true });
        message.scrollIntoView({ block: "nearest" });
      } catch (error) {
        if (request.signal.aborted) return;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const missing = code === "notFound" || code === "forbidden";
        status.textContent = t(missing ? "projects.memoryTerrainEvidenceUnavailable" : "harness.errorUnavailable");
        retry.hidden = missing;
      }
    }
    retry.onclick = () => void load();
    void load();
  }

  return { show, hide };
}
