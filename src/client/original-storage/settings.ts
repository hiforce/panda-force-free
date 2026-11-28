import { SettingsPageLifetime } from "../settings-pages/lifetime.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type {
  OriginalStorageSettings,
  OriginalStorageMutation,
  OriginalStorageOperation,
} from "../../shared/storage/contracts.js";
import { originalStorageErrorMessages } from "../../shared/storage/messages.js";
import { getBrowserI18n, setMessageHtml } from "../i18n.js";
import { originalStorageRequest, OriginalStorageRequestError } from "./api.js";
import { emptyOriginalStorageForm, originalStorageHtml, readOriginalStorageForm } from "./view.js";
import { storageConnectionsApi } from "../workspace-tools/storage-api.js";
import type { RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";

const recoveryKey = "pf-original-storage-save";
function recovery() {
  try {
    const value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
    return value && /^[a-f0-9-]{36}$/.test(value.id) && Number.isSafeInteger(value.revision)
      ? { id: String(value.id), revision: Number(value.revision) }
      : null;
  } catch {
    return null;
  }
}
/** An uncertain write can be checked by its operation ID after the settings page closes. */
export function createOriginalStorageSettings(t: Translate) {
  const page = new SettingsPageLifetime();
  let host: HTMLElement | null = null,
    settings: OriginalStorageSettings | null = null,
    connections: RegisteredStorageConnection[] | null = null,
    form = emptyOriginalStorageForm(),
    pending = recovery(),
    previous: OriginalStorageMutation | null = null,
    notice: MessageId | null = null,
    busy = false,
    formRevision = 0,
    feedbackAtSubmit = false;
  const get = <T extends HTMLElement>(selector: string) => host?.querySelector<T>(selector) ?? null;
  function remember() {
    try {
      if (pending) sessionStorage.setItem(recoveryKey, JSON.stringify(pending));
      else sessionStorage.removeItem(recoveryKey);
    } catch {
      /* Receipt recovery remains available during this page lifetime. */
    }
  }
  function paintNotice() {
    const target = get("[data-storage-notice]");
    if (target) target.textContent = notice ? t(notice) : "";
    const inline = get("[data-storage-inline-notice]");
    if (inline) inline.textContent = feedbackAtSubmit && !pending && notice ? t(notice) : "";
    if (target) target.classList.toggle("sr-only", feedbackAtSubmit && !pending);
  }
  function revealFeedback() {
    if (!host || !notice) return;
    const active = document.activeElement;
    if (active !== document.body && active && !host.contains(active)) return;
    const target =
      (!pending && feedbackAtSubmit ? get("[data-storage-inline-notice]") : null) ?? get("[data-storage-notice]");
    target?.scrollIntoView({ block: "nearest" });
    if (active === document.body)
      get<HTMLButtonElement>(pending ? '[data-storage-action="check"]' : "[data-storage-save]")?.focus({
        preventScroll: true,
      });
  }
  function controls() {
    if (!host) return;
    for (const fieldset of host.querySelectorAll<HTMLFieldSetElement>("[data-storage-fields]"))
      fieldset.disabled = busy || !!pending || !settings || !connections;
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-storage-action]")) button.disabled = busy;
    host.setAttribute("aria-busy", String(busy));
    const save = get<HTMLButtonElement>("[data-storage-save]");
    if (save) save.textContent = t(busy && previous ? "storage.saving" : "storage.savePlacement");
  }
  function render(capture = true) {
    if (!host) return;
    if (capture) form = readOriginalStorageForm(host, form);
    const active = document.activeElement;
    const key =
      active instanceof HTMLElement && host.contains(active)
        ? (active.dataset.storageField ?? active.dataset.storageAction ?? active.dataset.storageKind)
        : undefined;
    setMessageHtml(host, originalStorageHtml(t, connections, form, !!pending, !!previous));
    paintNotice();
    controls();
    if (key)
      get<HTMLElement>(
        `[data-storage-field="${key}"],[data-storage-action="${key}"],[data-storage-kind="${key}"]`,
      )?.focus({ preventScroll: true });
  }
  function adopt(value: OriginalStorageSettings) {
    settings = value;
    formRevision = value.revision;
    form = { kinds: [...value.kinds], profileId: value.mode === "s3" ? (value.activeProfileId ?? "") : "" };
  }
  async function load() {
    const [value, catalog] = await Promise.all([
      originalStorageRequest<OriginalStorageSettings>("", undefined, page.signal),
      storageConnectionsApi.list(page.signal),
    ]);
    return { value, connections: catalog.connections };
  }
  function showError(error: unknown) {
    notice =
      originalStorageErrorMessages[error instanceof OriginalStorageRequestError ? error.code : "storageUnavailable"];
    paintNotice();
  }
  async function refresh(adoptForm = true, clearPending = false) {
    if (!host || busy) return;
    const current = page.epoch;
    busy = true;
    feedbackAtSubmit = false;
    notice = "storage.loading";
    paintNotice();
    controls();
    try {
      const latest = await load();
      if (current !== page.epoch) return;
      const { value } = latest;
      connections = latest.connections;
      if (adoptForm) adopt(value);
      else settings = value;
      if (clearPending) {
        pending = null;
        previous = null;
        remember();
      }
      notice = pending ? "storage.unknownSave" : value.revision !== formRevision ? "storage.errorConflict" : null;
      render(false);
    } catch (error) {
      if (current === page.epoch) showError(error);
    } finally {
      if (current === page.epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function submit(repeat = false) {
    if (!host || busy || !settings || !connections || (pending && !repeat)) return;
    form = readOriginalStorageForm(host, form);
    notice = null;
    feedbackAtSubmit = true;
    let input: OriginalStorageMutation;
    if (repeat) {
      if (!previous) return;
      input = previous;
    } else {
      const { profileId, kinds } = form;
      if (profileId && !kinds.length) notice = "storage.chooseKinds";
      else if (profileId && !connections.some((row) => row.id === profileId && row.provider !== "google-drive"))
        notice = "storage.missingDestination";
      if (notice) {
        paintNotice();
        revealFeedback();
        return;
      }
      input = {
        revision: formRevision,
        operationId: crypto.randomUUID(),
        action: "placement",
        kinds,
        ...(profileId ? { mode: "s3", profileId } : { mode: "local" }),
      };
    }
    previous = input;
    pending = { id: input.operationId, revision: input.revision };
    remember();
    const current = page.epoch;
    busy = true;
    render(false);
    try {
      const result = await originalStorageRequest<{ savedRevision: number; settings: OriginalStorageSettings }>(
        "",
        input,
        page.signal,
      );
      if (current !== page.epoch) return;
      adopt(result.settings);
      pending = null;
      previous = null;
      remember();
      notice = "storage.saved";
      render(false);
    } catch (error) {
      if (current !== page.epoch) return;
      if (error instanceof OriginalStorageRequestError && [400, 401, 403, 409, 413].includes(error.status)) {
        pending = null;
        previous = null;
        remember();
        showError(error);
      } else notice = "storage.unknownSave";
      render(false);
    } finally {
      if (current === page.epoch) {
        busy = false;
        controls();
        revealFeedback();
      }
    }
  }
  async function checkSave() {
    if (!host || busy || !pending) return;
    const current = page.epoch;
    busy = true;
    controls();
    try {
      const result = await originalStorageRequest<OriginalStorageOperation | null>(
        "/operations/" + pending.id,
        undefined,
        page.signal,
      );
      if (current !== page.epoch) return;
      if (result?.state === "saved") {
        const value = await originalStorageRequest<OriginalStorageSettings>("", undefined, page.signal);
        if (current !== page.epoch) return;
        adopt(value);
        pending = null;
        previous = null;
        remember();
        notice = "storage.saved";
      } else if (result?.state === "not-saved") {
        pending = null;
        previous = null;
        remember();
        notice = "storage.notSaved";
        const latest = await originalStorageRequest<OriginalStorageSettings>("", undefined, page.signal);
        if (current !== page.epoch) return;
        settings = latest;
      } else notice = "storage.pendingSave";
      render(false);
    } catch (error) {
      if (current === page.epoch) showError(error);
    } finally {
      if (current === page.epoch) {
        busy = false;
        controls();
        revealFeedback();
      }
    }
  }
  function hide() {
    page.invalidate();

    if (host) {
      form = readOriginalStorageForm(host, form);
      host.replaceChildren();
    }
    connections = null;
    previous = null;
    notice = null;
    feedbackAtSubmit = false;
    host = null;
    busy = false;
  }
  function show(element: HTMLElement) {
    if (host === element) return;
    hide();
    host = element;
    page.renew();
    pending = recovery();
    render(false);
    element.addEventListener(
      "input",
      () => {
        form = readOriginalStorageForm(element, form);
      },
      { signal: page.signal },
    );
    element.addEventListener(
      "change",
      (event) => {
        const target = event.target as HTMLElement;
        form = readOriginalStorageForm(element, form);
        if (target.dataset.storageField === "profileId") {
          const kinds = get("[data-storage-s3]");
          if (kinds) kinds.hidden = !form.profileId;
        }
      },
      { signal: page.signal },
    );
    element.addEventListener(
      "submit",
      (event) => {
        const form = event.target as HTMLFormElement;
        if (!form.dataset.storageForm) return;
        event.preventDefault();
        void submit();
      },
      { signal: page.signal },
    );
    element.addEventListener(
      "click",
      (event) => {
        const action = (event.target as Element).closest<HTMLElement>("[data-storage-action]")?.dataset.storageAction;
        if (action === "reload") void refresh();
        else if (action === "current") void refresh(true, true);
        else if (action === "check") void checkSave();
        else if (action === "retry") void submit(true);
      },
      { signal: page.signal },
    );
    void refresh(!settings);
  }
  getBrowserI18n().subscribe(() => render());
  return { show, hide };
}
