import { localizeAttribute, setMessageHtml } from "../i18n.js";

import { codexIcon } from "../codex-icons.js";
import { attachmentsFromInput, composerTextFromInput } from "../composer-attachments.js";
import { CreationSkills } from "../creation/skills.js";
import { composerSkillButton } from "../composer-skill-button.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../shared/creation/contracts.js";
import { sessionSkillsFromInput } from "../../shared/session-skills.js";
import { canonicalData } from "../../shared/read-model.js";
import { createComposerDisclosure } from "../message-composer-disclosure.js";
import { parseWorkbenchRoute } from "../workbench-route.js";
import { creationSessionRoute } from "../creation/session-route.js";
import { selectCreationSkill } from "../creation/drafts.js";
import { creationDraftAfterAcknowledgement } from "../creation/submitted-draft.js";
import { busyIndicator } from "../busy-indicator.js";

// Owns drafts, IME input and submit-control projections; native delivery is delegated.
/** @param {import("./ports.js").FeatureOptions<"drafts" | "mutations" | "state" | "$" | "t" | "viewUpdates" | "identity", "uploads" | "status" | "delivery" | "models" | "workbench" | "transport", "composer">} options */
export function assembleComposer({
  drafts,
  mutations,
  state,
  $,
  t,
  uploadsPort,
  statusPort,
  deliveryPort,
  viewUpdates,
  modelsPort,
  identity,
  workbenchPort,
  transportPort,
}) {
  const {
    composerHistory,
    loadComposerHistory,
    persistComposerDraft,
    clearComposerDraft,
    getComposerDraft,
    setComposerDraft,
  } = drafts;
  const initialRoute = parseWorkbenchRoute();
  const disclosure = createComposerDisclosure(
    $("#composer"),
    t,
    identity,
    creationSessionRoute()?.key ||
      state.active?.id ||
      (initialRoute.page === "task" ? initialRoute.id : "new:" + (state.newSessionProjectId || "personal")),
  );
  $("#composer").addEventListener("composer:visibility-changed", () => resizePrompt());
  let skills = /** @type {CreationSkills | null} */ (null);
  const skillControl = $("#composerSkillControl");
  setMessageHtml(skillControl, composerSkillButton(t, "data-session-skills"));
  skillControl.onclick = () => {
    if (!skills) {
      skills = new CreationSkills(
        $("#composerSkills"),
        t,
        state.composerSkills,
        DOCUMENT_CREATION_CAPABILITIES,
        () => {
          mutations.set("composerSkills", skills?.read() || []);
          persistComposerDraft();
          viewUpdates.request("workbench");
        },
        () => {
          // Picker load failures are displayed by the existing retryable browser.
        },
        "composer",
      );
    }
    skills.browse(/** @type {HTMLElement} */ ($('[data-composer-control="add"]')));
  };
  $("#composer").addEventListener("composer:browse-skills", () => skillControl.click());
  function renderComposerSkills() {
    if (!skills && state.composerSkills.length) {
      skills = new CreationSkills(
        $("#composerSkills"),
        t,
        state.composerSkills,
        DOCUMENT_CREATION_CAPABILITIES,
        () => {
          mutations.set("composerSkills", skills?.read() || []);
          persistComposerDraft();
          viewUpdates.request("workbench");
        },
        () => {},
        "composer",
      );
    } else skills?.setSelected(state.composerSkills);
  }
  /** @param {string} [scope] */
  function saveComposerDraft(scope) {
    if (scope) {
      setComposerDraft(scope, {
        text: $("#prompt").value,
        mentions: canonicalData(state.composerMentions),
        attachments: canonicalData(state.composerAttachments),
        skills: canonicalData(state.composerSkills),
        ...(scope.startsWith("creation:") ? { creationSkillsVersion: 1 } : {}),
      });
      return;
    }
    persistComposerDraft();
  }
  function restoreComposerDraft() {
    disclosure.setScope(
      creationSessionRoute()?.key || state.active?.id || "new:" + (state.newSessionProjectId || "personal"),
    );
    composerHistory.setReplay(
      (state.active?.turns || []).flatMap((turn) =>
        (turn.items || [])
          .filter((item) => item.type === "userMessage")
          .map((item) => ({
            text: composerTextFromInput(item.content),
            attachments: attachmentsFromInput(item.content),
          })),
      ),
    );
    const creation = creationSessionRoute();
    let draft = getComposerDraft();
    // Old acknowledgements left a skill-only draft indistinguishable from a new selection.
    if (creation && draft && !draft.creationSkillsVersion && !draft.text.trim() && !draft.attachments.length) {
      draft = { ...draft, creationSkillsVersion: 1, skills: [] };
      setComposerDraft(creation.key, draft);
    }
    $("#prompt").value = draft?.text || "";
    mutations.set("composerMentions", draft?.mentions || []);
    mutations.set("composerAttachments", [...(draft?.attachments || [])]);
    const previousInput = (state.active?.turns || [])
      .flatMap((turn) => turn.items || [])
      .filter((item) => item.type === "userMessage")
      .at(-1)?.content;
    mutations.set("composerSkills", [
      ...(draft?.skills ?? (creation ? [] : sessionSkillsFromInput(previousInput).map((skill) => skill.selection))),
    ]);
    renderComposerSkills();
    uploadsPort.renderComposerAttachments();
    resizePrompt();
  }
  let promptComposing = false;

  function activeTurnId() {
    const creation = creationSessionRoute() ? workbenchPort.workbench?.creationSession() : null;
    if (creation) return creation.running ? creation.key : "";
    return statusPort.sessionRuntime.activeTurnId(state.active);
  }
  function canQueuePrompt() {
    return Boolean(creationSessionRoute()) || !transportPort.harnessManaged();
  }
  function syncQueueButton() {
    const queue = $("#queueButton");
    if (queue)
      queue.disabled =
        !canQueuePrompt() ||
        (!$("#prompt").value.trim() && !state.composerAttachments.length) ||
        !uploadsPort.composerAttachmentsReady() ||
        promptComposing ||
        deliveryPort.isSending(deliveryPort.pendingMessageOwner());
  }
  function syncComposerSubmitState() {
    disclosure.refresh();
    syncQueueButton();
    const button = $("#sendButton");
    if (!button) return;
    const turnId = activeTurnId();
    button.dataset.turnId = turnId;
    const creation = creationSessionRoute() ? workbenchPort.workbench?.creationSession() : null;
    const sending = creation?.sending ?? deliveryPort.isSending(deliveryPort.pendingMessageOwner());
    const managedActive = Boolean(turnId) && !canQueuePrompt();
    const hasDraft = Boolean($("#prompt").value.trim() || state.composerAttachments.length);
    creation?.observeDraft(hasDraft);
    const wait = $("#composerTurnWait");
    const showWait = managedActive && hasDraft;
    if (wait.hidden === showWait) {
      wait.hidden = !showWait;
      if (showWait) $("#prompt").setAttribute("aria-describedby", wait.id);
      else $("#prompt").removeAttribute("aria-describedby");
    }
    button.disabled = sending || (!managedActive && !uploadsPort.composerAttachmentsReady());
    if (sending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    const mode = sending ? "sending" : turnId ? (!managedActive && hasDraft ? "steer" : "stop") : "send",
      label =
        mode === "sending"
          ? creation
            ? "creation.creating"
            : "common.sending"
          : mode === "stop"
            ? "common.stop"
            : mode === "steer"
              ? creation
                ? "creation.updateTask"
                : "sessions.steer"
              : "common.sendMessage";
    // Preserve the pressed element when polling refreshes an unchanged control.
    if (button.dataset.submitMode !== mode || !button.firstElementChild)
      setMessageHtml(button, sending ? busyIndicator : codexIcon(mode === "stop" ? "square" : "arrowUp"));
    button.dataset.submitMode = mode;
    button.classList.toggle("stop", mode === "stop");
    button.classList.toggle("steer", mode === "steer");
    localizeAttribute(button, "title", label, undefined, t);
    localizeAttribute(button, "aria-label", label, undefined, t);
  }
  function setActiveTurnId(turnId = "") {
    const threadId = state.active?.id,
      previous = statusPort.sessionRuntime.get(threadId)?.turn;
    if (!threadId) return;
    if (turnId)
      statusPort.updateThreadListActivity(threadId, { status: { type: "active" }, turnId, turnStatus: "inProgress" });
    else if (previous?.status === "inProgress")
      statusPort.updateThreadListActivity(threadId, {
        status: { type: "idle" },
        turnId: previous.id,
        turnStatus: "interrupted",
        completed: true,
      });
    syncComposerSubmitState();
  }
  function syncTurnRuntime(turn) {
    if (state.active) statusPort.sessionRuntime.observeTurn(state.active.id, turn, state.active.turns.at(-1)?.id);
    syncComposerSubmitState();
  }
  function resizePrompt() {
    const e = $("#prompt");
    e.style.height = "auto";
    // The shared stylesheet bounds input growth against the viewport.
    e.style.height = e.scrollHeight + "px";
    syncComposerSubmitState();
  }
  function setComposing(value) {
    promptComposing = value;
  }

  function setPlanMode(active) {
    mutations.set("planMode", Boolean(active));
    viewUpdates.request("composerPlaceholder");
    modelsPort.syncPermissionControl();
  }
  /** @param {string} threadId @param {readonly import('../../shared/creation/contracts.js').CreationSkillSelection[]} submittedSkills */
  function clearDraft(threadId, submittedSkills = []) {
    if (state.active?.id === threadId && ($("#prompt").value || state.composerAttachments.length)) {
      persistComposerDraft();
      return;
    }
    const selected = state.active?.id === threadId ? state.composerSkills : submittedSkills;
    clearComposerDraft(threadId);
    // Empty selections are an explicit override of skills on older messages.
    setComposerDraft(threadId, { text: "", mentions: [], attachments: [], skills: [...selected] });
  }
  return {
    acceptCreationSubmission(scope, nextScope, prompt, materialIds, selections) {
      const current = creationSessionRoute()?.key === scope;
      if (current) persistComposerDraft();
      const draft = getComposerDraft(scope);
      if (!draft) return;
      const next = creationDraftAfterAcknowledgement(draft, prompt, materialIds, selections);
      const existing = nextScope === scope ? null : getComposerDraft(nextScope);
      const occupied = Boolean(existing?.text || existing?.attachments.length || existing?.skills?.length);
      setComposerDraft(
        scope,
        nextScope === scope || occupied
          ? next
          : { text: "", mentions: [], attachments: [], skills: [], creationSkillsVersion: 1 },
      );
      if (nextScope !== scope && !occupied) setComposerDraft(nextScope, next);
      if (current) restoreComposerDraft();
    },
    selectComposerSkill(selection) {
      mutations.set("composerSkills", selectCreationSkill(canonicalData(state.composerSkills), selection));
      renderComposerSkills();
      persistComposerDraft();
      resizePrompt();
    },
    readComposerSkills: () => canonicalData(state.composerSkills),
    renderComposerSkills,
    setPlanMode,
    setComposing,
    canQueuePrompt,
    syncQueueButton,
    saveComposerDraft,
    syncComposerSubmitState,
    persistComposerDraft,
    composerHistory,
    restoreComposerDraft,
    resizePrompt,
    syncTurnRuntime,
    get promptComposing() {
      return promptComposing;
    },
    activeTurnId,
    getComposerDraft,
    setComposerDraft,
    loadComposerHistory,
    setActiveTurnId,
    clearComposerDraft: clearDraft,
  };
}
