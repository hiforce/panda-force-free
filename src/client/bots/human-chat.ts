import type { BotChatMessage, BotChatSnapshot, BotChatSubmission, BotChatRead } from "../../shared/bots/workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { setMessageHtml } from "../i18n.js";
import { documentPreview } from "../documents/preview.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, botDate, type BotContext } from "./ui.js";

export interface BotChatDraft {
  text: string;
  generation: number;
  uncertain?: BotChatSubmission;
}

/** Drafts belong to one authenticated workspace; an ambiguous send retains its original request key. */
export function createBotHumanChat(
  context: BotContext,
  host: HTMLElement,
  botId: string,
  draft: BotChatDraft,
  identity: string,
) {
  const { h, button } = botUi(context.t),
    base = "/" + botId + "/chat";
  let alive = true,
    generation = 0,
    version = 0,
    sending = false,
    busy = false,
    hasMore = false,
    oldest = 0,
    paging = false,
    cleanup: BotChatSnapshot["cleanup"] = "ready",
    cursor = "",
    lastRead = 0,
    loading: { version: number; promise: Promise<void> } | null = null;
  const messages = new Map<string, BotChatMessage>(),
    fingerprints = new Map<string, string>(),
    elements = new Map<string, HTMLElement>();
  setMessageHtml(
    host,
    `<section class="bot-human-chat"><div class="bot-chat-tools">${button("bots.loadEarlier", "data-earlier disabled")}${button("bots.clearChat", "data-clear disabled", false, "trash")}</div><div class="bot-chat-cleanup" data-cleanup role="status" hidden></div><div class="bot-chat-history" role="log" aria-live="polite" aria-relevant="additions" data-history></div><form class="bot-chat-composer wb-form"><label class="wb-field"><span>${h("bots.messageLabel")}</span><textarea data-message rows="3" maxlength="32000" required></textarea></label><div><p data-reply-status role="status"></p>${button("bots.resolvePreviousSend", "data-send-recovery hidden")}<button class="wb-button primary" type="submit" disabled>${h("bots.send")}</button></div></form></section>`,
  );
  const input = host.querySelector<HTMLTextAreaElement>("[data-message]")!,
    submit = host.querySelector<HTMLButtonElement>("[type=submit]")!,
    clear = host.querySelector<HTMLButtonElement>("[data-clear]")!,
    earlier = host.querySelector<HTMLButtonElement>("[data-earlier]")!,
    history = host.querySelector<HTMLElement>("[data-history]")!,
    status = host.querySelector<HTMLElement>("[data-reply-status]")!,
    cleanupElement = host.querySelector<HTMLElement>("[data-cleanup]")!;
  input.value = draft.text;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("panda-bot-human-chat") : null;
  function controls() {
    submit.disabled = !generation || sending || busy || !input.value.trim();
    clear.disabled = !generation;
    earlier.disabled = !hasMore || paging;
    host.querySelector<HTMLButtonElement>("[data-send-recovery]")!.hidden = !draft.uncertain || sending;
    status.textContent = sending ? context.t("bots.sending") : busy ? context.t("bots.replying") : "";
  }
  function discardDraft() {
    draft.text = "";
    draft.uncertain = undefined;
    input.value = "";
  }
  function reset(next: number) {
    version++;
    messages.clear();
    fingerprints.clear();
    elements.clear();
    cursor = "";
    history.replaceChildren();
    oldest = 0;
    hasMore = false;
    if (draft.generation && draft.generation !== next) {
      discardDraft();
      context.notice(context.t("bots.clearedElsewhere"));
    }
    generation = next;
    draft.generation = next;
  }
  function draw() {
    const atEnd = history.getBoundingClientRect().bottom < innerHeight + 160,
      ordered = [...messages.values()].sort((a, b) => a.sequence - b.sequence);
    history.querySelector("[data-chat-empty]")?.remove();
    if (!ordered.length)
      setMessageHtml(history, `<p class="bot-chat-empty" data-chat-empty>${h("bots.chatEmpty")}</p>`);
    for (const message of ordered) {
      let element = elements.get(message.id);
      if (!element) {
        element = document.createElement("article");
        element.className = "bot-chat-message";
        element.dataset.messageId = message.id;
        element.dataset.role = message.role;
        elements.set(message.id, element);
        const following = [...history.children].find(
          (el) => (messages.get((el as HTMLElement).dataset.messageId ?? "")?.sequence ?? 0) > message.sequence,
        );
        history.insertBefore(element, following ?? null);
      }
      const fingerprint = JSON.stringify(message);
      if (fingerprints.get(message.id) === fingerprint) continue;
      fingerprints.set(message.id, fingerprint);
      const failure: Record<string, MessageId> = {
        interrupted: "bots.failureInterrupted",
        rateLimited: "bots.failureRateLimited",
        authentication: "bots.failureAuthentication",
        unavailable: "bots.failureUnavailable",
        failed: "bots.failureFailed",
      };
      setMessageHtml(
        element,
        `<header><strong>${h(message.role === "user" ? "bots.userRole" : "bots.assistantRole")}</strong><time datetime="${new Date(message.createdAt).toISOString()}">${e(botDate(message.createdAt))}</time></header><div class="bot-chat-text" data-i18n-ignore>${message.role === "user" ? e(message.text).replaceAll("\n", "<br>") : documentPreview(message.text)}</div>${message.status === "queued" || message.status === "running" ? `<p class="bot-hint">${h(message.status === "queued" ? "bots.waitingReply" : "bots.replying")}</p>` : message.status === "error" ? `<p class="bot-hint">${h(failure[message.failure ?? "failed"] ?? "bots.failureFailed")}</p>${button("bots.retryReply", "data-retry-reply")}` : ""}`,
      );
      element.querySelector<HTMLButtonElement>("[data-retry-reply]")?.addEventListener("click", () => {
        const previous = ordered.find((m) => m.sequence === message.sequence - 1 && m.role === "user");
        if (previous) void context.execute(() => send(previous.text, true));
      });
    }
    if (atEnd && ordered.length) history.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "instant" });
    for (const retry of history.querySelectorAll<HTMLButtonElement>("[data-retry-reply]"))
      retry.disabled = sending || busy;
  }
  function accept(snapshot: BotChatSnapshot, older = false) {
    if (!alive || snapshot.generation < generation) return;
    if (generation !== snapshot.generation) reset(snapshot.generation);
    if (!older && snapshot.replace) {
      messages.clear();
      fingerprints.clear();
      elements.clear();
      history.replaceChildren();
      oldest = 0;
    }
    if (!older) {
      busy = snapshot.busy;
      cleanup = snapshot.cleanup;
      cursor = snapshot.cursor ?? "";
    }
    if (!older && !oldest) hasMore = snapshot.hasMore;
    if (older) hasMore = snapshot.hasMore;
    for (const message of snapshot.messages) messages.set(message.id, message);
    oldest = messages.size ? Math.min(...[...messages.values()].map((m) => m.sequence)) : 0;
    if (draft.uncertain && snapshot.messages.some((m) => m.requestId === draft.uncertain!.requestId)) {
      const text = draft.uncertain.text;
      draft.uncertain = undefined;
      if (input.value.trim() === text) {
        input.value = "";
        draft.text = "";
      }
    }
    cleanupElement.hidden = cleanup === "ready";
    setMessageHtml(
      cleanupElement,
      cleanup === "ready"
        ? ""
        : `${h(cleanup === "pending" ? "bots.cleanupPending" : "bots.cleanupBlocked")}${cleanup === "blocked" ? button("bots.retryCleanup", "data-retry-cleanup") : ""}`,
    );
    cleanupElement.querySelector<HTMLButtonElement>("button")?.addEventListener("click", () => {
      void context.execute(async () => {
        await context.api(base + "/cleanup/retry", "POST", {});
        await reload();
      });
    });
    draw();
    controls();
  }
  function reload(passive = false): Promise<void> {
    if (passive && !busy && cleanup === "ready" && Date.now() - lastRead < 10000) return Promise.resolve();
    if (loading?.version === version) return loading.promise;
    const current = version,
      work = (async () => {
        const snapshot = await context.api<BotChatRead>(base + (cursor ? "?since=" + encodeURIComponent(cursor) : ""));
        if (!alive || current !== version) return;
        lastRead = Date.now();
        if (!("unchanged" in snapshot)) accept(snapshot);
      })().finally(() => {
        if (loading?.promise === work) loading = null;
      });
    loading = { version: current, promise: work };
    return work;
  }
  async function send(override?: string, retry = false) {
    if (!alive || !generation || sending || busy) return;
    const text = (override ?? input.value).trim();
    if (!text) return;
    if (draft.uncertain && (draft.uncertain.text !== text || draft.uncertain.generation !== generation)) {
      context.notice(context.t("bots.resolveSend"));
      await context.execute(reload);
      return;
    }
    const body = draft.uncertain ?? { requestId: crypto.randomUUID(), generation, text };
    draft.uncertain = body;
    sending = true;
    controls();
    const current = version;
    try {
      await context.api(base, "POST", body);
      if (!alive || version !== current) return;
      draft.uncertain = undefined;
      if (!retry && input.value.trim() === text) {
        input.value = "";
        draft.text = "";
      }
      busy = true;
      context.notice("");
      await reload();
    } catch (error) {
      if (alive && version === current) {
        const code = error instanceof Error ? error.message : "";
        if (
          ["invalidInput", "chatBusy", "staleConversation", "idempotencyConflict", "forbidden", "notFound"].includes(
            code,
          )
        )
          draft.uncertain = undefined;
        await context.execute(reload);
        throw error;
      }
    } finally {
      if (alive) {
        sending = false;
        controls();
      }
    }
  }
  host.querySelector<HTMLButtonElement>("[data-send-recovery]")!.onclick = () => {
    if (draft.uncertain) void context.execute(() => send(draft.uncertain!.text, true));
  };
  input.oninput = () => {
    draft.text = input.value;
    controls();
  };
  host.querySelector<HTMLFormElement>("form")!.onsubmit = (event) => {
    event.preventDefault();
    void context.execute(() => send());
  };
  earlier.onclick = () => {
    if (paging || !hasMore) return;
    paging = true;
    controls();
    const current = version,
      before = history.firstElementChild?.getBoundingClientRect().top ?? 0;
    void context.execute(async () => {
      try {
        const snapshot = await context.api<BotChatSnapshot>(base + "?before=" + oldest);
        if (alive && current === version && snapshot.generation === generation) {
          const anchor = history.firstElementChild;
          accept(snapshot, true);
          if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - before);
        }
      } finally {
        paging = false;
        controls();
      }
    });
  };
  clear.onclick = () => {
    const expected = generation,
      requestId = crypto.randomUUID(),
      dialog = botDialog(
        host,
        context,
        "bots.clearTitle",
        "bots.clearHint",
        `<div class="bot-dialog-actions">${button("bots.clearConfirm", "data-confirm-clear", true)}</div>`,
      );
    dialog.querySelector<HTMLButtonElement>("[data-confirm-clear]")!.onclick = () => {
      if (dialog.dataset.pending === "true") return;
      void context.execute(async () => {
        dialogPending(dialog, true);
        try {
          const result = await context.api<{ generation: number }>(base + "/clear", "POST", {
            requestId,
            generation: expected,
          });
          if (!alive) return;
          discardDraft();
          reset(Math.max(generation, result.generation));
          busy = false;
          channel?.postMessage({ identity, botId });
          dialog.close();
          await reload();
          context.notice(context.t("bots.chatCleared"));
        } catch (error) {
          if (alive) await reload();
          throw error;
        } finally {
          dialogPending(dialog, false);
        }
      });
    };
  };
  if (channel)
    channel.onmessage = (event) => {
      if (event.data?.identity !== identity || event.data?.botId !== botId || !alive) return;
      version++;
      discardDraft();
      messages.clear();
      fingerprints.clear();
      elements.clear();
      cursor = "";
      history.replaceChildren();
      generation = 0;
      draft.generation = 0;
      busy = false;
      controls();
      context.notice(context.t("bots.clearedElsewhere"));
      void context.execute(reload);
    };
  return {
    reload,
    hide() {
      alive = false;
      version++;
      draft.text = input.value;
      channel?.close();
    },
  };
}
