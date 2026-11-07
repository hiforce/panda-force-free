import { isTransportSwitch } from "../shared/errors.js";
import { errorMessage } from "./../shared/errors.js";
import { findElement, findElements, requireElement } from "./dom.js";
import { request as fetch } from "./http-client.js";
import { localizeText, messageHtml, setMessageHtml } from "./i18n.js";
import {
  approvalDecisionResponse,
  buildApprovalModel,
  normalizeApprovalRequest,
  permissionRows,
} from "../shared/codex-surfaces.js";
import { codexIcon } from "./codex-icons.js";
import { createUserInputCard, USER_INPUT_METHODS } from "./user-input.js";
/**
 * Approval and user-input request cards: rendering, decision submission via
 * respondToEngine, pending-request replay when switching threads, and the
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
  respondToEngine,
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
  mutations,
}) {
  const pendingApprovals = new Map();
  const userInputDrafts = new Map();
  // Submission state belongs to the request, because history can replace its card.
  const approvalSubmissions = new Map();
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
  requireElement("header button", inbox).onclick = () => inbox.close();
  function pendingChanged() {
    notice.hidden = pendingApprovals.size === 0;
    localizeText(notice, "approvals.reviewRequestsCount", { count: pendingApprovals.size }, t);
    onPendingChange();
    if (!pendingApprovals.size && inbox.open) inbox.close();
  }
  i18n?.subscribe(() => {
    pendingChanged();
    localizeText(findElement("header h2", inbox), "approvals.requestsRequiringYourAttention", undefined, t);
    localizeText(findElement("header button", inbox), "common.close", undefined, t);
  });
  notice.onclick = () => {
    inbox.showModal();
    for (const req of pendingApprovals.values())
      void onServerRequest(req, { container: findElement(".approval-inbox-list", inbox) });
  };
  inbox.addEventListener("close", () => {
    for (const [id, card] of state.requestCards)
      if (inbox.contains(card)) {
        card.remove();
        mutations.collection("requestCards").delete(id);
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
    approvalSubmissions.delete(requestId);
    pendingChanged();
    userInputDrafts.delete(requestId);
    approvalMenuController.closeFor(card);
    card?.remove();
    mutations.collection("requestCards").delete(requestId);
  }
  function restorePendingApprovals() {
    for (const req of pendingApprovals.values())
      if (inbox.open || belongsToActiveThread(req.params || {})) void onServerRequest(req);
  }
  function syncApprovalSubmission(requestId) {
    const card = state.requestCards.get(requestId);
    if (!card) return;
    const submission = approvalSubmissions.get(requestId);
    card.dataset.submitting = String(Boolean(submission?.pending));
    findElements("button", card).forEach((button) => (button.disabled = Boolean(submission?.pending)));
    let message = findElement(".approval-submit-error", card);
    if (!submission?.failed) {
      message?.remove();
      return;
    }
    if (!message) {
      message = document.createElement("p");
      message.className = "approval-submit-error";
      message.setAttribute("role", "alert");
      card.append(message);
    }
    localizeText(message, "errors.couldNotSubmitTheDecisionTheRequestIsStillWaiting", undefined, t);
  }
  async function onServerRequest(
    req,
    { container = inbox.open ? findElement(".approval-inbox-list", inbox) : null } = {},
  ) {
    req = normalizeApprovalRequest(req);
    const p = req.params || {};
    const existing = state.requestCards.get(req.id);
    const visible =
      existing?.isConnected && (container ? container.contains(existing) : $("#conversation").contains(existing));
    const canShow = container || belongsToActiveThread(p);
    if (req.surface?.kind === "questions" || USER_INPUT_METHODS.includes(req.method)) {
      if (req.surface?.kind === "questions") req = { ...req, params: { ...p, questions: req.surface.questions } };
      pendingApprovals.set(req.id, req);
      pendingChanged();
      if (!canShow || visible) return;
      approvalMenuController.closeFor(existing);
      existing?.remove();
      const draft = userInputDrafts.get(req.id) || {};
      userInputDrafts.set(req.id, draft);
      const card = createUserInputCard(req, {
        t,
        respond: respondToEngine,
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
      (container || requireElement(".turn-event-stream", ensureTurnTimeline(p.turnId || "questions"))).append(card);
      mutations.collection("requestCards").set(req.id, card);
      scrollBottom();
      return;
    }
    if (
      req.surface?.kind !== "approval" &&
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(req.method)
    ) {
      void respondToEngine(req.id, null, { code: -32601, message: "Unsupported request" }).catch((error) => {
        if (!(error instanceof Error && "silentTransportSwitch" in error && error.silentTransportSwitch))
          addPersistentError(error.message);
      });
      return;
    }
    pendingApprovals.set(req.id, req);
    pendingChanged();
    if (!canShow || visible) return;
    approvalMenuController.closeFor(existing);
    existing?.remove();
    const group = container ? null : ensureActivity(p.turnId || "approval", $("#conversation"), p.itemId),
      model = req.surface?.kind === "approval" ? req.surface.model : buildApprovalModel(req),
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
    mutations.collection("requestCards").set(req.id, card);
    syncApprovalSubmission(req.id);
    if (group) setApprovalWaiting(group, p.itemId, true);
    const answer = async (decision) => {
      approvalMenuController.closeFor(card);
      if (approvalSubmissions.get(req.id)?.pending) return;
      const submission = { pending: true, failed: false };
      approvalSubmissions.set(req.id, submission);
      syncApprovalSubmission(req.id);
      try {
        await respondToEngine(req.id, req.surface ? decision : approvalDecisionResponse(req, decision, model.kind));
        if (approvalSubmissions.get(req.id) !== submission) return;
        if (group) setApprovalWaiting(group, p.itemId, decision !== model.deny.decision);
        resolveServerRequest(req.id);
      } catch (error) {
        if (pendingApprovals.has(req.id) && approvalSubmissions.get(req.id) === submission) {
          submission.pending = false;
          submission.failed = true;
          syncApprovalSubmission(req.id);
          if (!isTransportSwitch(error)) addPersistentError(errorMessage(error));
        }
      }
    };
    requireElement("form", card).onsubmit = (e) => {
      e.preventDefault();
      answer(model.primary.decision);
    };
    requireElement(".approval-deny", card).onclick = () => answer(model.deny.decision);
    findElement(".approval-scoped", card)?.addEventListener(
      "click",
      () => model.scoped && answer(model.scoped.decision),
    );
    findElement(".approval-leading", card)?.addEventListener(
      "click",
      () => model.leading && answer(model.leading.decision),
    );
    findElement(".approval-review-link", card)?.addEventListener("click", () => openReviewPanel(diffForTurn(p.turnId)));
    scrollBottom();
  }
  function clearApprovals({ removeCards = false } = {}) {
    approvalMenuController.close();
    pendingApprovals.clear();
    approvalSubmissions.clear();
    pendingChanged();
    userInputDrafts.clear();
    if (removeCards) for (const card of state.requestCards.values()) card.remove();
    mutations.collection("requestCards").clear();
  }
  return {
    pendingInteraction: (id) => {
      const request = [...pendingApprovals.values()].find(
        (req) => req.params?.threadId === id || (!req.params?.threadId && state.active?.id === id),
      );
      return request ? (USER_INPUT_METHODS.includes(request.method) ? "question" : "approval") : null;
    },
    pendingCard: (id) => {
      const request = [...pendingApprovals.values()].find(
        (req) => req.params?.threadId === id || (!req.params?.threadId && state.active?.id === id),
      );
      return request ? state.requestCards.get(request.id) || null : null;
    },
    onServerRequest,
    resolveServerRequest,
    restorePendingApprovals,
    clearApprovals,
    hasPendingApproval: (id) => [...pendingApprovals.values()].some((req) => req.params?.threadId === id),
    refreshPendingApprovals,
  };
}
