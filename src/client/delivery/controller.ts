import { AccountEditor } from "../accounts/controller.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import type { SiteBuild } from "../../shared/builds/jobs.js";
import type { SitePublication, SitePublicationRequest } from "../../shared/delivery/contracts.js";
import type { PublicationConnection } from "../../shared/connections/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml as m, errorText } from "../i18n.js";

import { deliveryApi, DeliveryApiError } from "./api.js";
import { ConnectionEditor } from "./connection-editor.js";
import { button, connectionOptions, deliveryFrame, publicationHistory, publicationPlan } from "./views.js";

export function createDeliveryWorkspace(t: Translate) {
  const dialog = document.createElement("dialog");
  dialog.id = "sitePublicationDialog";
  dialog.className = "delivery-dialog";
  document.body.append(dialog);
  const editor = new ConnectionEditor(t, (items) => {
    connections = items;
    preparation();
  });
  const accounts = new AccountEditor(t);
  let epoch = 0,
    busy = false,
    selected = "",
    signature = "",
    previous: Element | null = null,
    space: DocumentSpace | null = null,
    build: SiteBuild | undefined;
  let projectId: string | undefined;
  let reads = 0;
  let connections: PublicationConnection[] = [],
    items: SitePublication[] = [],
    pending: SitePublicationRequest | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  const get = <T extends Element>(selector: string) => dialog.querySelector<T>(selector)!;
  function notice(text: string) {
    const el = get<HTMLElement>("#deliveryNotice");
    if (el) {
      el.textContent = text;
      el.hidden = !text;
    }
  }
  function report(error: unknown) {
    notice(errorText(error instanceof DeliveryApiError ? error.payload : null, t, "delivery.unavailable"));
  }
  function close() {
    epoch++;
    reads++;
    clearTimeout(timer);
    editor.close();
    accounts.close();
    dialog.close();
    space = null;
    projectId = undefined;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  }
  function tab(name: string) {
    get<HTMLElement>("#deliveryConnections").hidden = name !== "connections";
    get<HTMLElement>("#deliveryPublications").hidden = name !== "history";
    get<HTMLElement>("#deliveryAccounts").hidden = name !== "accounts";
    for (const key of ["connections", "history", "accounts"])
      get(`[data-delivery-action="${key}"]`).setAttribute("aria-pressed", String(name === key));
  }
  function preparation() {
    const target = get<HTMLElement>("#deliveryPreparation");
    if (!target) return;
    const previous = get<HTMLSelectElement>("#publicationTarget")?.value;
    const enabled = connections.filter((item) => item.enabled);
    setMessageHtml(
      target,
      build
        ? `<h3>${m("delivery.currentBuild", undefined, t)}</h3><p data-i18n-ignore>${e(build.site.title)} · ${e(build.site.url + build.site.basePath)}</p><p>${m("delivery.prepareHint", undefined, t)}</p><div class="delivery-actions"><label for="publicationTarget">${m("connections.choose", undefined, t)}</label><select id="publicationTarget">${connectionOptions(enabled)}</select>${button(t, "delivery.prepare", "prepare", true)}</div>${!enabled.length ? `<p>${m("connections.noConnections", undefined, t)}</p>` : ""}`
        : `<p>${m("delivery.selectBuild", undefined, t)}</p>`,
    );
    if (previous && enabled.some((item) => item.id === previous))
      get<HTMLSelectElement>("#publicationTarget").value = previous;
    controls();
  }
  function controls() {
    for (const el of dialog.querySelectorAll<HTMLButtonElement>("[data-delivery-action]")) {
      const action = el.dataset.deliveryAction!;
      el.disabled =
        (busy && !["close", "connections", "history", "accounts"].includes(action)) ||
        (action === "prepare" && !connections.some((item) => item.enabled));
    }
    const picker = get<HTMLSelectElement>("#publicationTarget");
    if (picker) picker.disabled = busy;
  }
  function draw() {
    const next = JSON.stringify({ items, selected });
    if (signature === next) return;
    signature = next;
    const list = get<HTMLElement>("#deliveryHistory"),
      top = list.scrollTop;
    setMessageHtml(list, publicationHistory(t, items, selected));
    list.scrollTop = top;
    const record = items.find((item) => item.plan.id === selected);
    setMessageHtml(get("#deliveryPlan"), record ? publicationPlan(t, record) : "");
    if (record?.job.error)
      get<HTMLElement>("#deliveryJobError").textContent = errorText(
        { messageId: `delivery.${record.job.error}` },
        t,
        "delivery.deliveryFailed",
      );
    controls();
  }
  async function refresh() {
    if (!space) return;
    const generation = epoch,
      read = ++reads,
      result = await deliveryApi.list(space.id, projectId);
    if (generation !== epoch || read !== reads) return;
    items = result.publications;
    if (!selected) selected = items[0]?.plan.id || "";
    draw();
  }
  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const generation = epoch;
      try {
        if (
          !document.hidden &&
          !busy &&
          items.some((item) => ["queued", "running", "reconciling"].includes(item.job.phase))
        )
          await refresh();
      } catch (error) {
        if (generation === epoch) report(error);
      } finally {
        if (generation === epoch && dialog.open) poll();
      }
    }, 2000);
  }
  async function act(action: string, target: HTMLButtonElement) {
    if (action === "connections" || action === "history" || action === "accounts") {
      tab(action);
      return;
    }
    if (action === "select") {
      selected = target.dataset.id!;
      draw();
      return;
    }
    if (action === "refresh") {
      await refresh();
      return;
    }
    const generation = epoch;
    if (action === "prepare" && build) {
      const connection = connections.find((item) => item.id === get<HTMLSelectElement>("#publicationTarget").value);
      if (!connection) return;
      const request = {
        id: pending?.id || crypto.randomUUID(),
        buildId: build.id,
        connectionId: connection.id,
        connectionVersion: connection.version,
        ...(projectId === undefined ? {} : { projectId }),
      };
      if (pending && JSON.stringify(pending) !== JSON.stringify(request)) request.id = crypto.randomUUID();
      pending = request;
      const result = await deliveryApi.prepare(request);
      if (generation !== epoch) return;
      pending = null;
      selected = result.publication.plan.id;
    } else {
      const record = items.find((item) => item.plan.id === selected);
      if (!record) return;
      if (action === "publish") await deliveryApi.publish(record.plan.id, record.plan.fingerprint);
      if (action === "cancel") await deliveryApi.cancel(record.plan.id);
      if (action === "reconcile") await deliveryApi.reconcile(record.plan.id);
      if (action === "recover") await deliveryApi.recover(record.plan.id, record.plan.fingerprint);
    }
    if (generation === epoch) {
      await refresh();
      notice("");
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-delivery-action]") : null;
    if (!target || target.disabled) return;
    const action = target.dataset.deliveryAction!;
    if (action === "close") {
      close();
      return;
    }
    if (busy) return;
    const generation = epoch;
    busy = true;
    controls();
    void act(action, target)
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
    open(value: DocumentSpace, currentBuild?: SiteBuild, sourceProjectId?: string) {
      close();
      previous = document.activeElement;
      space = value;
      build = currentBuild;
      projectId = sourceProjectId ?? currentBuild?.projectId;
      connections = [];
      items = [];
      selected = "";
      signature = "";
      pending = null;
      busy = false;
      setMessageHtml(dialog, deliveryFrame(t, value.name));
      get<HTMLButtonElement>('[data-delivery-action="accounts"]').hidden = projectId !== undefined;
      dialog.showModal();
      tab(currentBuild ? "history" : "connections");
      preparation();
      notice(t("delivery.loading"));
      const generation = epoch;
      void Promise.all([
        editor.mount(get("#deliveryConnections"), value.projectId),
        ...(projectId === undefined ? [accounts.mount(get("#deliveryAccounts"), value.projectId)] : []),
        refresh(),
      ])
        .then(() => {
          if (generation === epoch) notice("");
        })
        .catch((error) => {
          if (generation === epoch) report(error);
        });
      poll();
    },
  };
}
