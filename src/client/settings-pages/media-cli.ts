import type {
  CreationMediaCliInstructions,
  CreationMediaCliRegistration,
} from "../../shared/creation/media-executors.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { harnessApi } from "../harness/api.js";
import { localizeText, setOpaqueText } from "../i18n.js";

const endpoint = "/api/personal/creation-media-cli";
type Catalog = { configured: boolean; packages: CreationMediaCliRegistration[] };
const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(25000)]);

export function createMediaCliSettings(t: Translate, onRegistered: () => Promise<void>) {
  const api = harnessApi(t);
  let request: AbortController | undefined;

  function instructions(item: CreationMediaCliRegistration, signal: AbortSignal) {
    const details = document.createElement("details"),
      summary = document.createElement("summary"),
      content = document.createElement("div");
    content.className = "media-cli-instructions";
    localizeText(summary, "creation.mediaCliInstructions", {}, t);
    details.append(summary, content);
    let loading = false,
      ready = false;
    details.ontoggle = () => {
      if (!details.open || loading || ready || signal.aborted) return;
      loading = true;
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      content.replaceChildren(status);
      localizeText(status, "settings.pageLoading", {}, t);
      const query = new URLSearchParams({ id: item.id, revision: String(item.revision) });
      void api<CreationMediaCliInstructions>(endpoint + "?" + query, "GET", undefined, requestSignal(signal))
        .then(
          ({ install, usage }) => {
            if (signal.aborted) return;
            ready = true;
            content.replaceChildren();
            for (const [label, value] of [
              ["creation.mediaCliDigest", item.sha256],
              ["creation.mediaCliInstall", install],
              ["creation.mediaCliUsage", usage],
            ] as const) {
              const section = document.createElement("div"),
                heading = document.createElement("h3"),
                text = document.createElement("pre");
              localizeText(heading, label, {}, t);
              setOpaqueText(text, value);
              section.append(heading, text);
              content.append(section);
            }
          },
          () => {
            if (!signal.aborted) localizeText(status, "creation.mediaCliInstructionsFailed", {}, t);
          },
        )
        .finally(() => {
          loading = false;
        });
    };
    return details;
  }

  function row(item: CreationMediaCliRegistration, signal: AbortSignal) {
    const form = document.createElement("div"),
      name = document.createElement("strong"),
      version = document.createElement("small"),
      status = document.createElement("p"),
      action = document.createElement("div"),
      button = document.createElement("button");
    form.className = "media-cli-package";
    form.dataset.mediaCliPackage = item.id;
    setOpaqueText(name, item.name);
    localizeText(version, "creation.mediaCliVersion", { version: item.version, revision: item.revision }, t);
    status.setAttribute("role", "status");
    status.tabIndex = -1;
    button.type = "button";
    button.className = "wb-button";
    localizeText(button, "creation.mediaCliRegister", {}, t);
    action.append(button);
    form.append(name, version, instructions(item, signal), status, action);
    const completed = (focused = false) => {
      action.hidden = true;
      localizeText(status, "creation.mediaCliRegistered", {}, t);
      if (focused) status.focus({ preventScroll: true });
    };
    if (item.registered) completed();
    else status.hidden = true;
    button.onclick = () => {
      if (button.disabled || signal.aborted) return;
      const initiatedWithFocus = document.activeElement === button;
      const keepFocus = () =>
        initiatedWithFocus && [button, document.body].includes(document.activeElement as HTMLElement);
      button.disabled = true;
      status.hidden = false;
      localizeText(status, "creation.mediaCliChecking", {}, t);
      const { id, revision, fingerprint } = item;
      void api(endpoint, "POST", { id, revision, fingerprint }, requestSignal(signal)).then(
        () => {
          if (signal.aborted) return;
          completed(keepFocus());
          void onRegistered();
        },
        (error: { code?: string }) => {
          if (signal.aborted) return;
          localizeText(
            status,
            error.code === "conflict" ? "creation.mediaCliChanged" : "creation.mediaCliVerificationFailed",
            {},
            t,
          );
          button.disabled = false;
          if (keepFocus()) button.focus({ preventScroll: true });
        },
      );
    };
    return form;
  }

  function hide() {
    request?.abort();
    request = undefined;
  }

  function show(host: HTMLElement) {
    hide();
    request = new AbortController();
    const { signal } = request;
    host.hidden = false;
    host.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "executor-form-notice";
    loading.setAttribute("role", "status");
    localizeText(loading, "settings.pageLoading", {}, t);
    host.append(loading);
    void api<Catalog>(endpoint, "GET", undefined, requestSignal(signal)).then(
      ({ configured, packages }) => {
        if (signal.aborted) return;
        host.replaceChildren();
        host.hidden = !configured;
        if (!configured) return;
        const header = document.createElement("header"),
          title = document.createElement("h3"),
          notice = document.createElement("p");
        header.className = "wb-section-heading";
        localizeText(title, "creation.mediaCliSettings", {}, t);
        header.append(title);
        localizeText(notice, packages.length ? "creation.mediaCliReadyHelp" : "creation.mediaCliEmpty", {}, t);
        host.append(header, notice, ...packages.map((item) => row(item, signal)));
        host.hidden = false;
      },
      (error: { code?: string }) => {
        if (signal.aborted) return;
        if (error.code === "forbidden") {
          host.hidden = true;
          host.replaceChildren();
          return;
        }
        host.replaceChildren();
        const status = document.createElement("p"),
          retry = document.createElement("button");
        status.setAttribute("role", "status");
        localizeText(status, "creation.mediaLoadFailed", {}, t);
        retry.className = "wb-button";
        retry.type = "button";
        localizeText(retry, "common.retry", {}, t);
        retry.onclick = () => show(host);
        host.append(status, retry);
        host.hidden = false;
      },
    );
  }

  return { show, hide };
}
