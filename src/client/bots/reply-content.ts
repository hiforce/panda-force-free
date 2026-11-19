import { marked, type Token } from "marked";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { copyPlainText } from "../clipboard-text.js";
import { documentPreview } from "../documents/preview.js";
import { setMessageHtml } from "../i18n.js";
import { botUi } from "./ui.js";

export interface BotReplyPart {
  kind: "prose" | "markdown" | "code";
  text: string;
  language?: string;
}

/** Explicit deliverables keep conversational framing outside their copyable source. */
export function botReplyParts(text: string): BotReplyPart[] {
  const parts: BotReplyPart[] = [],
    tokens = marked.lexer(text, { gfm: true });
  let pending: Token[] = [];
  const flush = () => {
    const start = pending.findIndex((token) => ["heading", "list", "table"].includes(token.type));
    const append = (kind: BotReplyPart["kind"], items: Token[]) => {
      const source = items.map((token) => token.raw).join("");
      if (source.trim()) parts.push({ kind, text: source });
    };
    if (start < 0) append("prose", pending);
    else {
      append("prose", pending.slice(0, start));
      append("markdown", pending.slice(start));
    }
    pending = [];
  };
  for (const token of tokens) {
    if (token.type !== "code") {
      pending.push(token);
      continue;
    }
    flush();
    const language = token.lang?.split(/\s/)[0] ?? "";
    parts.push({ kind: /^(?:md|markdown)$/i.test(language) ? "markdown" : "code", text: token.text, language });
  }
  flush();
  return parts;
}

export function botReplyHtml(parts: BotReplyPart[], t: Translate): string {
  const { h, button, attributes } = botUi(t);
  return parts
    .map((part, index) => {
      if (part.kind === "prose")
        return `<div class="bot-chat-markdown" data-i18n-ignore>${documentPreview(part.text)}</div>`;
      const markdown = part.kind === "markdown";
      return `<section class="bot-chat-content-card" data-content-block="${index}"><header><strong>${markdown ? h("bots.markdownContent") : part.language ? `<span data-i18n-ignore>${e(part.language)}</span>` : h("bots.codeContent")}</strong><div role="group" ${attributes("aria-label", "bots.contentActions")}>${markdown ? `${button("documents.preview", `data-content-view="preview" aria-pressed="true"`)}${button("bots.markdownSource", `data-content-view="source" aria-pressed="false"`)}` : ""}${button("bots.copyContent", "data-copy-content", false, "copy")}</div></header>${markdown ? `<div class="bot-chat-markdown bot-chat-content-preview" data-content-preview data-i18n-ignore>${documentPreview(part.text)}</div><textarea class="bot-chat-content-source" data-content-source data-i18n-ignore readonly rows="8" hidden ${attributes("aria-label", "bots.markdownSource")}>${e(part.text)}</textarea>` : `<pre data-i18n-ignore><code>${e(part.text)}</code></pre>`}</section>`;
    })
    .join("");
}

/** Copy exact source, not rendered text with toolbar labels or lost Markdown formatting. */
export function bindBotReplyContent(
  root: HTMLElement,
  parts: BotReplyPart[],
  t: Translate,
  notice: (text: string) => void,
) {
  for (const card of root.querySelectorAll<HTMLElement>("[data-content-block]")) {
    const part = parts[Number(card.dataset.contentBlock)]!;
    for (const button of card.querySelectorAll<HTMLButtonElement>("[data-content-view]"))
      button.onclick = () => {
        const source = button.dataset.contentView === "source";
        card.querySelector<HTMLElement>("[data-content-preview]")!.hidden = source;
        card.querySelector<HTMLTextAreaElement>("[data-content-source]")!.hidden = !source;
        for (const toggle of card.querySelectorAll<HTMLButtonElement>("[data-content-view]"))
          toggle.setAttribute("aria-pressed", String(toggle === button));
      };
    bindBotCopy(card.querySelector<HTMLButtonElement>("[data-copy-content]")!, () => part.text, t, notice);
  }
}

export function bindBotCopy(
  button: HTMLButtonElement,
  read: () => string | Promise<string>,
  t: Translate,
  notice: (text: string) => void,
  enabled: () => boolean = () => true,
) {
  let pending = false,
    reset: ReturnType<typeof setTimeout> | undefined;
  const original = button.innerHTML;
  button.onclick = () => {
    if (button.disabled || pending) return;
    pending = true;
    clearTimeout(reset);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const done = () => {
      notice(t("common.copied"));
      if (button.isConnected)
        setMessageHtml(
          button,
          botUi(t).icon("check") +
            (button.classList.contains("bot-icon-button")
              ? `<span class="sr-only">${botUi(t).h("common.copied")}</span>`
              : botUi(t).h("common.copied")),
        );
      reset = setTimeout(() => {
        if (button.isConnected) setMessageHtml(button, original);
      }, 1600);
    };
    const run = async () => {
      const value = read();
      // Safari requires clipboard permission to be requested during the click itself.
      if (typeof value !== "string" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined")
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })) }),
        ]);
      else await copyPlainText(await value);
      done();
    };
    void run()
      .catch((error) =>
        notice(
          t(
            error instanceof Error && error.message === "staleConversation"
              ? "bots.staleConversation"
              : error instanceof Error && error.message === "copyTooLarge"
                ? "bots.copyTooLarge"
                : "workbench.copyFailedPleaseSelectAndCopyTheMessageManually",
          ),
        ),
      )
      .finally(() => {
        pending = false;
        button.disabled = !enabled();
        button.removeAttribute("aria-busy");
      });
  };
}
