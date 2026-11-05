import { localizeText, messageHtml, setMessageHtml } from "./i18n.js";

import {
  buildApprovalModel,
  permissionRows,
  normalizeApprovalRequest,
  approvalDecisionResponse,
} from "../shared/codex-surfaces.js";
import { createUserInputCard, USER_INPUT_METHODS } from "./user-input.js";
import { codexIcon } from "./codex-icons.js";

/**
 * Approval and user-input request cards: rendering, decision submission via
 * respondToCodex, pending-request replay when switching threads, and the
 * disconnect cleanup. Conversation anchoring (timelines, activities,
 * scrolling) is injected from the conversation renderer.
 */
export function createApprovals({
  onPendingChange = () => {},
  i18n,
  $,
  t,
  state,
  approvalMenuController,
  respondToCodex,
  addPersistentError,
  escapeHtml,
  shortPath,
  belongsToActiveThread,
  ensureTurnTimeline,
  ensureActivity,
  setApprovalWaiting,
  scrollBottom,
  diffForTurn,
  openReviewPanel,
}) {
  const pendingApprovals = new Map();
  const userInputDrafts = new Map();
  const notice = document.createElement("button");
  notice.id = "pendingApprovalNotice";
  notice.type = "button";
  notice.className = "pending-approval-notice";
  notice.hidden = true;
  notice.setAttribute("aria-live", "polite");
  document.body.append(notice);
  const inbox = document.createElement("dialog");
  inbox.id = "approvalInboxDialog";
  inbox.className = "workbench-dialog approval-inbox";
  setMessageHtml(
    inbox,
    `<header><h2>${messageHtml("approvals.requestsRequiringYourAttention", undefined, t)}</h2><button type="button" class="wb-button">${messageHtml("common.close", undefined, t)}</button></header><div class="approval-inbox-list"></div>`,
  );
  document.body.append(inbox);
  inbox.querySelector("header button").onclick = () => inbox.close();
  function pendingChanged() {
    notice.hidden = pendingApprovals.size === 0;
    localizeText(notice, "approvals.reviewRequestsCount", { count: pendingApprovals.size }, t);
    onPendingChange();
    if (!pendingApprovals.size && inbox.open) inbox.close();
  }
  i18n?.subscribe(() => {
    pendingChanged();
    localizeText(inbox.querySelector("header h2"), "approvals.requestsRequiringYourAttention", undefined, t);
    localizeText(inbox.querySelector("header button"), "common.close", undefined, t);
  });
  notice.onclick = () => {
    inbox.showModal();
    for (const req of pendingApprovals.values())
      void onServerRequest(req, { container: inbox.querySelector(".approval-inbox-list") });
  };
  inbox.addEventListener("close", () => {
    for (const [id, card] of state.requestCards)
      if (inbox.contains(card)) {
        card.remove();
        state.requestCards.delete(id);
      }
    restorePendingApprovals();
    if (!notice.hidden) notice.focus();
  });
  async function refreshPendingApprovals() {
    const before = new Map(pendingApprovals);
    try {
      const response = await fetch("/api/approvals", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const { requests } = await response.json();
      if (!Array.isArray(requests)) return;
      const ids = new Set(requests.map((req) => req.id));
      for (const [id, req] of before) if (!ids.has(id) && pendingApprovals.get(id) === req) resolveServerRequest(id);
      for (const req of requests) await onServerRequest(req);
    } catch {
      /* The event stream remains authoritative while a refresh is unavailable. */
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshPendingApprovals();
  });
  function approvalIcon(kind) {
    return kind === "network"
      ? codexIcon("globe")
      : kind === "patch"
        ? codexIcon("fileDiff")
        : kind === "permission"
          ? codexIcon("shield")
          : codexIcon("terminal");
  }
  function approvalBody(model, p) {
    if (model.kind === "exec" || model.kind === "network")
      return `<div class="approval-command"><code>${escapeHtml(p.command || model.title)}</code></div>`;
    if (model.kind === "patch") {
      const review = diffForTurn(p.turnId);
      return review?.hasChanges
        ? `<button type="button" class="approval-review-link">${codexIcon("fileDiff")}${messageHtml("approvals.reviewChangedFiles", { count: review.fileCount }, t)}<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span></button>`
        : "";
    }
    return permissionRows(p.permissions)
      .map(
        (row) =>
          `<div class="permission-row"><span>${messageHtml(row.labelKey, undefined, t)}</span><code>${row.valueKey ? messageHtml(row.valueKey, undefined, t) : escapeHtml(shortPath(row.value))}</code></div>`,
      )
      .join("");
  }
  function resolveServerRequest(requestId) {
    const req = pendingApprovals.get(requestId),
      card = state.requestCards.get(requestId);
    if (card && !USER_INPUT_METHODS.includes(req?.method))
      setApprovalWaiting(card.previousElementSibling, req?.params?.itemId, false);
    pendingApprovals.delete(requestId);
    pendingChanged();
    userInputDrafts.delete(requestId);
    approvalMenuController.closeFor(card);
    card?.remove();
    state.requestCards.delete(requestId);
  }
  function restorePendingApprovals() {
    for (const req of pendingApprovals.values())
      if (inbox.open || belongsToActiveThread(req.params || {})) void onServerRequest(req);
  }
  async function onServerRequest(
    req,
    { container = inbox.open ? inbox.querySelector(".approval-inbox-list") : null } = {},
  ) {
    req = normalizeApprovalRequest(req);
    const p = req.params || {};
    const existing = state.requestCards.get(req.id);
    const visible =
      existing?.isConnected && (container ? container.contains(existing) : $("#conversation").contains(existing));
    const canShow = container || belongsToActiveThread(p);
    if (USER_INPUT_METHODS.includes(req.method)) {
      pendingApprovals.set(req.id, req);
      pendingChanged();
      if (!canShow || visible) return;
      approvalMenuController.closeFor(existing);
      existing?.remove();
      const draft = userInputDrafts.get(req.id) || {};
      userInputDrafts.set(req.id, draft);
      const card = createUserInputCard(req, {
        t,
        respond: respondToCodex,
        onResolved: resolveServerRequest,
        onError: (message) => addPersistentError(message),
        draft,
      });
      if (container) {
        const session = document.createElement("p");
        session.className = "approval-session-context";
        localizeText(
          session,
          "approvals.sessionContext",
          {
            name:
              state.threads.find((thread) => thread.id === p.threadId)?.name ||
              p.threadId ||
              t("approvals.currentWorkspace"),
          },
          t,
        );
        card.prepend(session);
      }
      (container || ensureTurnTimeline(p.turnId || "questions").querySelector(".turn-event-stream")).append(card);
      state.requestCards.set(req.id, card);
      scrollBottom();
      return;
    }
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(req.method)
    ) {
      void respondToCodex(req.id, null, { code: -32601, message: "Unsupported request" }).catch((error) => {
        if (!error?.silentTransportSwitch) addPersistentError(error.message);
      });
      return;
    }
    pendingApprovals.set(req.id, req);
    pendingChanged();
    if (!canShow || visible) return;
    approvalMenuController.closeFor(existing);
    existing?.remove();
    const group = container ? null : ensureActivity(p.turnId || "approval", $("#conversation"), p.itemId),
      model = buildApprovalModel(req),
      card = document.createElement("section");
    card.className = "approval-card";
    card.dataset.codexApprovalSurface = "";
    setMessageHtml(
      card,
      `<div class="approval-content"><div class="approval-identity">${approvalIcon(model.kind)}<span>${messageHtml(model.identityKey, model.identityValues, t)}</span></div><div class="approval-title">${messageHtml(model.titleKey, model.titleValues, t)}</div>${model.subtitle ? `<div class="approval-subtitle">${model.subtitleKey ? messageHtml(model.subtitleKey, model.subtitleValues, t) : escapeHtml(shortPath(model.subtitle))}</div>` : ""}${model.reason ? `<div class="approval-reason"><span>${messageHtml("approvals.reason", undefined, t)}</span><p>${escapeHtml(model.reason)}</p></div>` : ""}</div><div class="approval-body">${approvalBody(model, p)}</div><form class="approval-actions">${model.leading ? `<button type="button" class="approval-leading">${messageHtml(model.leading.labelKey, model.leading.labelValues, t)}</button>` : ""}<div class="approval-actions-main"><button type="submit" class="approval-primary">${messageHtml(model.primary.labelKey, model.primary.labelValues, t)}</button>${model.scoped ? `<button type="button" class="approval-scoped">${messageHtml(model.scoped.labelKey, model.scoped.labelValues, t)}</button>` : ""}<button type="button" class="approval-deny danger">${messageHtml(model.deny.labelKey, model.deny.labelValues, t)}</button></div></form>`,
    );
    if (container) {
      const session = document.createElement("p");
      session.className = "approval-session-context";
      localizeText(
        session,
        "approvals.sessionContext",
        {
          name:
            state.threads.find((thread) => thread.id === p.threadId)?.name ||
            p.threadId ||
            t("approvals.currentWorkspace"),
        },
        t,
      );
      card.prepend(session);
      container.append(card);
    } else group.after(card);
    state.requestCards.set(req.id, card);
    if (group) setApprovalWaiting(group, p.itemId, true);
    const answer = async (decision) => {
      approvalMenuController.closeFor(card);
      if (card.dataset.submitting === "true") return;
      card.dataset.submitting = "true";
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await respondToCodex(req.id, approvalDecisionResponse(req, decision, model.kind));
        if (group) setApprovalWaiting(group, p.itemId, decision !== model.deny.decision);
        resolveServerRequest(req.id);
      } catch (error) {
        if (pendingApprovals.has(req.id)) {
          card.dataset.submitting = "false";
          card.querySelectorAll("button").forEach((b) => (b.disabled = false));
          let message = card.querySelector(".approval-submit-error");
          if (!message) {
            message = document.createElement("p");
            message.className = "approval-submit-error";
            message.setAttribute("role", "alert");
            card.append(message);
          }
          localizeText(message, "errors.couldNotSubmitTheDecisionTheRequestIsStillWaiting", undefined, t);
          if (!error?.silentTransportSwitch) addPersistentError(error.message);
        }
      }
    };
    card.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      answer(model.primary.decision);
    };
    card.querySelector(".approval-deny").onclick = () => answer(model.deny.decision);
    card.querySelector(".approval-scoped")?.addEventListener("click", () => answer(model.scoped.decision));
    card.querySelector(".approval-leading")?.addEventListener("click", () => answer(model.leading.decision));
    card
      .querySelector(".approval-review-link")
      ?.addEventListener("click", () => openReviewPanel(diffForTurn(p.turnId)));
    scrollBottom();
  }

  function clearApprovals({ removeCards = false } = {}) {
    approvalMenuController.close();
    pendingApprovals.clear();
    pendingChanged();
    userInputDrafts.clear();
    if (removeCards) for (const card of state.requestCards.values()) card.remove();
    state.requestCards.clear();
  }

  return {
    onServerRequest,
    resolveServerRequest,
    restorePendingApprovals,
    clearApprovals,
    hasPendingApproval: (id) => [...pendingApprovals.values()].some((req) => req.params?.threadId === id),
    refreshPendingApprovals,
  };
}
