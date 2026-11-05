import { errorMessage } from "./../shared/errors.js";
import { requireElement } from "./dom.js";
import { request as fetch } from "./http-client.js";
import { getBrowserI18n, localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "./i18n.js";
import {
  createReviewPreferences,
  parseUnifiedDiff,
  splitDiffHunk,
  unifiedDiffFromFileChanges,
} from "../shared/codex-surfaces.js";
import { codexIcon } from "./codex-icons.js";
import { renderDiffLine } from "./diff-rendering.js";
import { storage, STORAGE_KEYS } from "./storage.js";
// Review preferences, patch actions and batched rendering have one owner.
export function createReviewController({
  $,
  t = getBrowserI18n().t,
  state,
  escapeHtml,
  shortPath,
  toast,
  addPersistentError,
  isRenderingTurn,
  openLauncher,
  mutations,
}) {
  const reviewPreferences = createReviewPreferences(JSON.parse(storage.get(STORAGE_KEYS.reviewPreferences) || "{}"));
  let reviewPatchState = "undo",
    pendingTurnReview = false,
    pendingChangesRender = false;
  function diffForTurn(turnId) {
    return state.turnDiffs.get(turnId) || null;
  }
  function recordTurnReview(turnId, raw, source = "fileChange") {
    if (!turnId || !raw) return null;
    const existing = state.turnDiffs.get(turnId);
    if (source !== "native" && existing?.source === "native") return existing;
    const review = parseUnifiedDiff(raw);
    if (!review.hasChanges) return null;
    review.turnId = turnId;
    review.raw = raw;
    review.source = source;
    mutations.collection("turnDiffs").set(turnId, review);
    mutations.set("activeReview", review);
    $("#reviewTab").hidden = false;
    renderChanges();
    return review;
  }
  function syncTurnReviewFromItems(turnId) {
    if (isRenderingTurn()) {
      pendingTurnReview = true;
      return;
    }
    const items = state.activityItems.get(turnId),
      changes = items
        ? [...items.values()].flatMap((item) =>
            item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : [],
          )
        : [],
      raw = unifiedDiffFromFileChanges(changes);
    if (raw) recordTurnReview(turnId, raw);
  }
  function saveReviewPreferences() {
    storage.set(STORAGE_KEYS.reviewPreferences, JSON.stringify(reviewPreferences));
  }
  const reviewLineHtml = (line) => renderDiffLine(line, escapeHtml);
  function reviewHunkHtml(hunk) {
    if (reviewPreferences.mode === "split") {
      return `<div class="review-split-lines">${splitDiffHunk(hunk)
        .map(
          (row) =>
            `<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`,
        )
        .join("")}</div>`;
    }
    return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join("")}</div>`;
  }
  function syncReviewControls(review) {
    const has = !!review?.hasChanges;
    $("#reviewMode").disabled = !has;
    $("#reviewWrap").disabled = !has;
    $("#reviewExpand").disabled = !has;
    $("#reviewPatch").disabled = !has || !state.active?.id || !review?.turnId;
    localizeAttribute(
      $("#reviewMode"),
      "title",
      reviewPreferences.mode === "unified" ? "common.switchToSplitDiff" : "common.switchToUnifiedDiff",
    );
    localizeAttribute(
      $("#reviewWrap"),
      "title",
      reviewPreferences.wrap ? "files.disableWordWrap" : "files.enableWordWrap",
    );
    localizeAttribute(
      $("#reviewExpand"),
      "title",
      reviewPreferences.expanded ? "common.collapseAllDiffs" : "common.expandAllDiffs",
    );
    localizeAttribute(
      $("#reviewPatch"),
      "title",
      reviewPatchState === "undo" ? "common.undoChanges" : "common.reapplyChanges",
    );
    setMessageHtml($("#reviewPatch"), codexIcon(reviewPatchState === "undo" ? "undo" : "redo"));
  }
  function renderChanges() {
    if (isRenderingTurn()) {
      pendingChangesRender = true;
      return;
    }
    const list = $("#changeList"),
      review = state.activeReview || [...state.turnDiffs.values()].at(-1) || null,
      reviewVisible = document.body.classList.contains("side-panel-open") && !$("#reviewPanelContent").hidden;
    document.body.classList.toggle(
      "review-split-open",
      reviewVisible && reviewPreferences.mode === "split" && !!review?.hasChanges && innerWidth > 1200,
    );
    list.dataset.mode = reviewPreferences.mode;
    list.classList.toggle("wrap", reviewPreferences.wrap);
    if (review?.hasChanges) {
      setOpaqueText($("#changeCount"), review.fileCount);
      localizeText($("#changeSummary"), "common.changedFiles", { count: review.fileCount }, t);
      setMessageHtml(
        $("#reviewStats"),
        `<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`,
      );
      setMessageHtml(list, "");
      for (const file of review.files) {
        const section = document.createElement("section");
        section.className = "review-file";
        section.dataset.path = file.path;
        setMessageHtml(
          section,
          `<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon("chevronDown", "review-chevron")}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded ? "" : " hidden"}></div>`,
        );
        const body = requireElement(".review-hunks", section);
        for (const hunk of file.hunks) {
          const h = document.createElement("div");
          h.className = "review-hunk";
          setMessageHtml(h, `<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`);
          body.append(h);
        }
        const head = requireElement(".review-file-head", section);
        head.onclick = () => {
          const open = head.getAttribute("aria-expanded") === "true";
          head.setAttribute("aria-expanded", String(!open));
          body.hidden = open;
        };
        list.append(section);
      }
      syncReviewControls(review);
      return;
    }
    setOpaqueText($("#reviewStats"), "");
    setOpaqueText($("#changeCount"), state.changes.size);
    localizeText(
      $("#changeSummary"),
      state.changes.size ? "common.changedFiles" : "common.noChangesYet",
      { count: state.changes.size },
      t,
    );
    setMessageHtml(list, "");
    for (const [path, ch] of state.changes) {
      const el = document.createElement("div");
      el.className = "change-item";
      setMessageHtml(
        el,
        `<div class="change-path">${codexIcon("file")}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions || 0}</span> <span class="minus">−${ch.deletions || 0}</span></div>`,
      );
      list.append(el);
    }
    if (!state.changes.size)
      setMessageHtml(
        list,
        '<div class="panel-empty"><span data-pf-message="common.changesWillAppearHere">Changes will appear here.</span></div>',
      );
    syncReviewControls(null);
  }
  async function applyActiveReviewPatch() {
    const review = state.activeReview;
    if (!review?.turnId || !state.active?.id) return;
    const action = reviewPatchState,
      button = $("#reviewPatch");
    button.disabled = true;
    setMessageHtml(button, codexIcon("loaderCircle", "review-loading"));
    try {
      const response = await fetch("/api/review/patch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: state.active.id,
            turnId: review.turnId,
            action,
          }),
        }),
        result = await response.json();
      if (!response.ok) throw new Error(result.error || "Review patch failed");
      if (state.activeReview !== review) return;
      reviewPatchState = action === "undo" ? "reapply" : "undo";
      toast(t(action === "undo" ? "common.changesReverted" : "common.changesReapplied"));
    } catch (error) {
      addPersistentError(errorMessage(error));
    } finally {
      if (state.activeReview === review) syncReviewControls(review);
    }
  }
  function resetReviewState() {
    mutations.collection("turnDiffs").clear();
    mutations.set("activeReview", null);
    reviewPatchState = "undo";
    $("#reviewTab").hidden = true;
    if (!$("#reviewPanelContent").hidden) openLauncher();
    renderChanges();
  }
  $("#reviewMode").onclick = () => {
    reviewPreferences.mode = reviewPreferences.mode === "unified" ? "split" : "unified";
    saveReviewPreferences();
    renderChanges();
  };
  $("#reviewWrap").onclick = () => {
    reviewPreferences.wrap = !reviewPreferences.wrap;
    saveReviewPreferences();
    renderChanges();
  };
  $("#reviewExpand").onclick = () => {
    reviewPreferences.expanded = !reviewPreferences.expanded;
    saveReviewPreferences();
    renderChanges();
  };
  $("#reviewPatch").onclick = applyActiveReviewPatch;
  return {
    diffForTurn,
    recordTurnReview,
    syncTurnReviewFromItems,
    renderChanges,
    resetReviewState,
    flush(turnId) {
      if (pendingTurnReview) {
        pendingTurnReview = false;
        syncTurnReviewFromItems(turnId);
      }
      if (pendingChangesRender) {
        pendingChangesRender = false;
        renderChanges();
      }
    },
  };
}
