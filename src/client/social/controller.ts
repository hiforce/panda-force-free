import { recoveryDisabled, recoveryAction } from "./recovery-controls.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { WorkflowRecord } from "../../shared/delivery/workflow.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText, isMessageId } from "../i18n.js";

import { accountsApi, AccountApiError } from "../accounts/api.js";
import { AccountEditor } from "../accounts/controller.js";
import { socialApi, SocialApiError } from "./api.js";
import { socialFrame, history, plan } from "./views.js";

/** Owns one modal's selections and lifetime. Polling replaces only changed publication records. */
export function createSocialWorkspace(t: Translate) {
  const dialog = document.createElement("dialog");
  dialog.id = "socialPublicationDialog";
  dialog.className = "delivery-dialog social-dialog";
  dialog.setAttribute("aria-labelledby", "socialTitle");
  document.body.append(dialog);
  const editor = new AccountEditor(t);
  let epoch = 0,
    busy = false,
    project = "",
    sourceProject: string | undefined,
    space = "",
    variant = "",
    selected = "",
    planSignature = "",
    listSignature = "",
    previous: Element | null = null;
  let items: WorkflowRecord[] = [],
    timer: ReturnType<typeof setTimeout> | undefined,
    pending: { id: string; variantId: string; connectionId: string } | null = null;
  let continuationPending: { id: string; parentId: string } | null = null;
  let articlePending: { id: string; draftId: string } | null = null;
  const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  function notice(text: string) {
    const node = get<HTMLElement>("#socialNotice");
    if (node) {
      node.textContent = text;
      node.hidden = !text;
    }
  }
  function report(error: unknown) {
    notice(
      errorText(
        error instanceof SocialApiError || error instanceof AccountApiError ? error.payload : null,
        t,
        "delivery.unavailable",
      ),
    );
  }
  function close() {
    const wasOpen = dialog.open;
    epoch++;
    clearTimeout(timer);
    editor.close();
    dialog.close();
    if (wasOpen && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  }
  function controls() {
    const settings = !get<HTMLElement>("#socialAccountSettings")?.hidden;
    const back = get<HTMLButtonElement>('[data-social-action="back"]'),
      accountButton = get<HTMLButtonElement>('[data-social-action="accounts"]');
    if (back) back.hidden = !settings;
    if (accountButton) accountButton.hidden = settings;
    for (const element of dialog.querySelectorAll<HTMLButtonElement>("[data-social-action]")) {
      const action = element.dataset.socialAction;
      element.disabled =
        action !== "close" &&
        (busy ||
          recoveryDisabled(action || "", element) ||
          (action === "prepare" && !get<HTMLSelectElement>("#socialTarget")?.value) ||
          (action === "submit" &&
            !(
              get<HTMLInputElement>("#socialAcceptCosts")?.checked &&
              get<HTMLInputElement>("#socialAcceptEligibility")?.checked
            )));
    }
    const target = get<HTMLSelectElement>("#socialTarget");
    if (target) target.disabled = busy;
  }
  function draw() {
    const signature = JSON.stringify({ items, selected });
    if (signature !== listSignature) {
      listSignature = signature;
      const node = get<HTMLElement>("#socialHistory"),
        top = node.scrollTop;
      setMessageHtml(node, history(t, items, selected));
      node.scrollTop = top;
    }
    const record = items.find((item) => item.plan.id === selected),
      next = JSON.stringify([record, record ? record.plan.expiresAt <= Date.now() : false]);
    if (next !== planSignature) {
      planSignature = next;
      if (record) {
        setMessageHtml(get("#socialPlan"), plan(t, record));
        if (record.error)
          get<HTMLElement>("#socialJobError").textContent = errorText(
            {
              messageId: isMessageId(`social.${record.error}`) ? `social.${record.error}` : `delivery.${record.error}`,
            },
            t,
            "delivery.deliveryFailed",
          );
      }
    }
    controls();
  }
  async function refreshAccounts() {
    const generation = epoch,
      result = await accountsApi.list(project);
    if (generation !== epoch) return;
    const target = get<HTMLSelectElement>("#socialTarget"),
      previous = target.value,
      choices = result.accounts.filter(
        (account) =>
          account.enabled &&
          account.account &&
          account.grant &&
          !["refreshing", "reauthorizationRequired"].includes(account.authorizationState || ""),
      );
    setMessageHtml(
      target,
      `<option value="">${e(t("social.chooseAccount"))}</option>` +
        choices
          .map(
            (account) =>
              `<option value="${e(account.id)}">${e(account.name)} · @${e(account.account!.username)}</option>`,
          )
          .join(""),
    );
    if (choices.some((account) => account.id === previous)) target.value = previous;
    else if (choices.length === 1) target.value = choices[0]!.id;
    get<HTMLElement>("#socialNoAccounts").hidden = choices.length > 0;
    controls();
  }
  async function refresh() {
    const generation = epoch,
      result = await socialApi.list(space, sourceProject);
    if (generation !== epoch) return;
    const previous = items.find((item) => item.plan.id === selected);
    if (previous && !result.publications.some((item) => item.plan.id === selected)) {
      const retained = await socialApi.detail(previous.plan.kind, previous.plan.id);
      if (generation !== epoch) return;
      result.publications.unshift(retained.publication);
    }
    items = result.publications;
    if (!selected) selected = items[0]?.plan.id || "";
    draw();
  }
  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const generation = epoch;
      try {
        if (!document.hidden && !busy && items.some((item) => ["queued", "running", "waiting"].includes(item.phase)))
          await refresh();
      } catch (error) {
        if (generation === epoch) report(error);
      } finally {
        if (generation === epoch && dialog.open) poll();
      }
    }, 2000);
  }
  function remember(record: WorkflowRecord) {
    items = [record, ...items.filter((item) => item.plan.id !== record.plan.id)];
    selected = record.plan.id;
  }
  async function act(action: string, button: HTMLButtonElement) {
    const generation = epoch;
    if (action === "select") {
      selected = button.dataset.id!;
      draw();
      return;
    }
    if (action === "related") {
      const result = await socialApi.detail(button.dataset.kind!, button.dataset.id!);
      if (generation !== epoch) return;
      remember(result.publication);
      draw();
      return;
    }
    if (action === "accounts") {
      get<HTMLElement>("#socialWorkspace").hidden = true;
      get<HTMLElement>("#socialAccountSettings").hidden = false;
      await editor.mount(get("#socialAccountSettings"), project);
      return;
    }
    if (action === "back") {
      editor.close();
      get<HTMLElement>("#socialAccountSettings").hidden = true;
      get<HTMLElement>("#socialWorkspace").hidden = false;
      await refreshAccounts();
      return;
    }
    if (action === "refresh-accounts") {
      await refreshAccounts();
      return;
    }
    if (action === "refresh") {
      await refresh();
      return;
    }
    if (action === "prepare") {
      const connectionId = get<HTMLSelectElement>("#socialTarget").value;
      if (!pending || pending.connectionId !== connectionId)
        pending = { id: crypto.randomUUID(), variantId: variant, connectionId };
      const result = await socialApi.prepare(pending);
      if (generation !== epoch) return;
      pending = null;
      remember(result.publication);
    } else {
      const record = items.find((item) => item.plan.id === selected);
      if (!record) return;
      if (action === "submit") {
        if (
          !get<HTMLInputElement>("#socialAcceptCosts")?.checked ||
          !get<HTMLInputElement>("#socialAcceptEligibility")?.checked
        )
          return;
        await socialApi.submit(record, record.phase === "failed");
      }
      if (action.startsWith("recovery-")) await recoveryAction(action, button, record);
      if (action === "cancel") await socialApi.cancel(record);
      if (action === "successor") {
        if (!continuationPending || continuationPending.parentId !== record.plan.id)
          continuationPending = { id: crypto.randomUUID(), parentId: record.plan.id };
        const result = await socialApi.successor(record, continuationPending.id);
        if (generation !== epoch) return;
        continuationPending = null;
        remember(result.publication);
      }
      if (action === "article") {
        if (!articlePending || articlePending.draftId !== record.plan.id)
          articlePending = { id: crypto.randomUUID(), draftId: record.plan.id };
        const result = await socialApi.article(articlePending);
        if (generation !== epoch) return;
        articlePending = null;
        remember(result.publication);
      }
    }
    if (generation === epoch) await refresh();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("change", controls);
  dialog.addEventListener("input", controls);
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-social-action]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.socialAction!;
    if (action === "close") {
      close();
      return;
    }
    if (busy) return;
    const generation = epoch;
    busy = true;
    controls();
    notice(t("delivery.working"));
    void act(action, button)
      .then(() => {
        if (generation === epoch) notice("");
      })
      .catch((error) => {
        if (generation === epoch) report(error);
      })
      .finally(() => {
        if (generation === epoch) {
          busy = false;
          controls();
        }
      });
  });
  return {
    close,
    open(spaceId: string, variantId: string, title: string) {
      close();
      previous = document.activeElement;
      space = spaceId;
      variant = variantId;
      project = "";
      sourceProject = undefined;
      items = [];
      selected = "";
      planSignature = "";
      listSignature = "";
      pending = null;
      articlePending = null;
      continuationPending = null;
      busy = true;
      setMessageHtml(dialog, socialFrame(t, title));
      dialog.showModal();
      controls();
      notice(t("delivery.loading"));
      const generation = epoch;
      void socialApi
        .context(variantId)
        .then(async (context) => {
          if (generation !== epoch) return;
          if (context.spaceId !== spaceId) throw Error("Publication context changed");
          project = context.projectId;
          sourceProject = context.sourceProjectId;
          await Promise.all([refreshAccounts(), refresh()]);
          if (generation === epoch) {
            notice("");
            poll();
          }
        })
        .catch((error) => {
          if (generation === epoch) report(error);
        })
        .finally(() => {
          if (generation === epoch) {
            busy = false;
            controls();
          }
        });
    },
  };
}
