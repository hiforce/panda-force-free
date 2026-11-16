import { executionView } from "./execution-view.js";
import { continuationView, canSubmit, publishedPost } from "./continuation-view.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { WorkflowRecord } from "../../shared/delivery/workflow.js";
import type { SocialPayload, ArticlePublishPayload } from "../../shared/delivery/social.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { mediaPreview } from "./media-view.js";
export const button = (t: Translate, key: MessageId, action: string, primary = false) =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}" data-social-action="${action}">${m(key, undefined, t)}</button>`;
export function phaseLabel(record: WorkflowRecord): MessageId {
  if (record.lineage?.successorId) return "social.superseded";
  if (record.cancellation && record.phase === "running") return "social.stopping";
  if (record.cancellation && record.phase === "cancelled" && record.steps.length) return "social.stopped";
  if (record.phase === "failed" && record.resolutions?.length && !record.error) return "social.reviewRemaining";
  if (record.phase === "waiting") return "social.waiting";
  if (record.phase === "completed")
    return record.plan.kind === "x-article-draft" ? "social.draftReady" : "social.completed";
  return `delivery.${record.phase}` as MessageId;
}
export const kindLabel = (kind: string): MessageId =>
  kind === "x-article-draft"
    ? "social.articleDraft"
    : kind === "x-article-publish"
      ? "social.articlePublish"
      : "social.post";
export function socialFrame(t: Translate, title: string) {
  return `<header class="delivery-heading"><div><span>${m("social.title", undefined, t)}</span><h2 id="socialTitle" data-i18n-ignore>${e(title)}</h2></div>${button(t, "delivery.close", "close")}</header>
  <div id="socialNotice" role="status" hidden></div><div class="social-toolbar">${button(t, "social.accounts", "accounts")}${button(t, "social.back", "back")}${button(t, "delivery.refresh", "refresh")}</div>
  <section id="socialAccountSettings" hidden></section><section id="socialWorkspace" class="social-workspace">
  <div class="social-preparation"><label for="socialTarget">${m("social.account", undefined, t)}</label><div><select id="socialTarget"></select>${button(t, "social.prepare", "prepare", true)}${button(t, "social.refreshAccounts", "refresh-accounts")}</div><p id="socialNoAccounts" hidden>${m("social.noAccounts", undefined, t)}</p><p>${m("social.planHint", undefined, t)}</p></div>
  <div class="social-layout"><details open class="social-history"><summary>${m("delivery.history", undefined, t)}</summary><div id="socialHistory"></div></details><section id="socialPlan"><p>${m("social.empty", undefined, t)}</p></section></div></section>`;
}
export function history(t: Translate, records: WorkflowRecord[], selected: string) {
  return (
    records
      .map(
        (record) =>
          `<button class="social-history-item" type="button" data-social-action="select" data-id="${e(record.plan.id)}" aria-pressed="${selected === record.plan.id}"><strong>${m(kindLabel(record.plan.kind), undefined, t)}</strong><span>${m(phaseLabel(record), undefined, t)}</span><small data-i18n-ignore>${e(new Date(record.plan.createdAt).toLocaleString())}</small></button>`,
      )
      .join("") || `<p>${m("delivery.noHistory", undefined, t)}</p>`
  );
}
export function plan(t: Translate, record: WorkflowRecord) {
  const payload = record.plan.payload as unknown as SocialPayload | ArticlePublishPayload;
  const ready = canSubmit(record);
  const source = payload.source,
    target = payload.target;
  const content = "content" in payload ? payload.content : { format: "x-article" as const, draft: payload.draft };
  const preview =
    content?.format === "x-article"
      ? `<h4 data-i18n-ignore>${e(content.draft.title)}</h4><pre data-i18n-ignore>${e(content.draft.content_state.blocks.map((block) => block.text).join("\n\n"))}</pre>${mediaPreview(t, record, payload.media || [])}`
      : content
        ? content.posts
            .map(
              (text, index) =>
                `<article><small>${index + 1} / ${content.posts.length}</small>${publishedPost(record, index) ? `<p class="social-inherited-note">${m("social.alreadyPublished", undefined, t)}</p>` : ""}<pre data-i18n-ignore>${e(text)}</pre>${mediaPreview(
                  t,
                  record,
                  (content.postMedia?.[index] || []).flatMap(
                    (key) => payload.media?.filter((image) => image.key === key) || [],
                  ),
                )}</article>`,
            )
            .join("")
        : "";
  const submitLabel =
    record.phase === "failed"
      ? "social.resume"
      : record.plan.kind === "x-article-draft"
        ? "social.submitDraft"
        : record.plan.kind === "x-article-publish"
          ? "social.submitArticle"
          : "social.submitPosts";
  return `<header class="social-plan-heading"><h3>${m(kindLabel(record.plan.kind), undefined, t)}</h3><span data-phase="${record.phase}">${m(phaseLabel(record), undefined, t)}</span></header>
  <dl class="social-metadata"><dt>${m("social.account", undefined, t)}</dt><dd data-i18n-ignore>@${e(target.username)}</dd><dt>${m("social.frozenVersion", undefined, t)}</dt><dd><code>${e(source.revisionId)}</code></dd><dt>${m("delivery.snapshot", undefined, t)}</dt><dd><code>${e(record.plan.fingerprint)}</code></dd></dl>
  <p id="socialJobError" role="status" ${record.error ? "" : "hidden"}></p>
  ${record.cancellation ? `<p class="social-stop-note" role="status">${m(record.phase === "running" ? "social.stopPendingHint" : record.phase === "completed" ? "social.stopAfterCompletionHint" : "social.stoppedHint", undefined, t)} <time>${e(new Date(record.cancellation.requestedAt).toLocaleString())}</time></p>` : ""}
  ${record.phase === "waiting" ? `<p role="status">${m("social.waitingHint", undefined, t)}</p>` : ""}
  ${record.phase === "needsAttention" ? `<p class="social-warning">${m("social.unknownHint", undefined, t)}</p>` : ""}
  ${record.phase === "failed" && record.steps.length ? `<p class="social-warning">${m("social.partialHint", undefined, t)}</p>` : ""}
  <div class="social-content">${preview}</div>
  ${executionView(t, record)}
  ${continuationView(t, record)}
  ${record.confirmations.length ? `<p class="social-confirmation-note">${m("social.confirmed", undefined, t)} · <time>${e(new Date(record.confirmations.at(-1)!.createdAt).toLocaleString())}</time></p>` : ""}
  <footer class="social-plan-actions">${ready ? `<label><input type="checkbox" id="socialAcceptCosts">${m("social.costs", undefined, t)}</label><label><input type="checkbox" id="socialAcceptEligibility">${m("social.eligibility", undefined, t)}</label>${button(t, submitLabel, "submit", true)}` : ""}
  ${!record.lineage?.successorId && !record.cancellation && !["completed", "cancelled"].includes(record.phase) ? button(t, record.phase === "prepared" ? "delivery.cancel" : "social.stop", "cancel") : ""}
  ${record.phase === "completed" && record.plan.kind === "x-article-draft" ? button(t, "social.prepareArticle", "article", true) : ""}</footer>`;
}
