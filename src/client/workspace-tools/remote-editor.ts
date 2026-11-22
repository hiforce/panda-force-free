import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type {
  RemoteConnection,
  RemoteConnectionInput,
  RemoteCredential,
  RemoteHost,
  RemoteHostKey,
} from "../../shared/workspace-tools/remote.js";
import { escapeHtml } from "../../shared/html.js";
import { busyIndicator } from "../busy-indicator.js";
import { confirmAction } from "../confirmation-dialog.js";
import { requireElement } from "../dom.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { remoteApi, RemoteApiError } from "./remote-api.js";

export function editRemote(t: Translate, change: () => void, profile?: RemoteConnection) {
  const dialog = document.createElement("dialog");
  const back = document.activeElement;
  const msg = (key: MessageId) => messageHtml(key, undefined, t);
  const field = (name: string, label: MessageId, input: string) =>
    `<label class="wb-field" for="remote-field-${name}"><span>${msg(label)}</span>${input}</label>`;
  const input = (name: string, value: string, options: string) =>
    `<input id="remote-field-${name}" name="ssh-${name}" value="${escapeHtml(value)}" ${options}>`;
  const method = profile?.method || "password";
  dialog.className = "workbench-dialog remote-editor";
  dialog.setAttribute("aria-labelledby", "remote-editor-title");
  setMessageHtml(
    dialog,
    `<header><h2 id="remote-editor-title">${msg(profile ? "remoteTools.edit" : "remoteTools.add")}</h2></header>
    <form class="wb-form">
      <div class="remote-editor-body">
      <div data-remote-fields>
      ${field("name", "remoteTools.name", input("name", profile?.name || "", 'required maxlength="120" autocomplete="off" autofocus'))}
      <div class="remote-endpoint-fields">
        ${field("host", "remoteTools.host", input("host", profile?.host || "", 'required maxlength="253" spellcheck="false" autocapitalize="none" autocomplete="off"'))}
        ${field("port", "remoteTools.port", input("port", String(profile?.port ?? 22), 'type="number" required min="1" max="65535"'))}
      </div>
      ${field("username", "remoteTools.username", input("username", profile?.username || "", 'required maxlength="64" autocomplete="off" autocapitalize="none"'))}
      ${field(
        "method",
        "connections.authMethod",
        `<select id="remote-field-method" name="ssh-method">
        <option value="password" ${method === "password" ? "selected" : ""}>${msg("connections.password")}</option>
        <option value="privateKey" ${method === "privateKey" ? "selected" : ""}>${msg("remoteTools.sshKey")}</option>
      </select>`,
      )}
      <div data-remote-credential="password">${field("password", "connections.password", input("password", "", 'type="password" maxlength="4096" autocomplete="new-password"'))}</div>
      <div data-remote-credential="privateKey">
        ${field("privateKey", "connections.privateKey", '<textarea id="remote-field-privateKey" name="ssh-privateKey" maxlength="32768" rows="4" spellcheck="false" autocapitalize="none" autocomplete="off"></textarea>')}
        ${field("passphrase", "connections.passphrase", input("passphrase", "", 'type="password" maxlength="4096" autocomplete="new-password"'))}
      </div>
      ${
        profile
          ? `<p class="wb-help">${msg("remoteTools.keepCredential")}</p>
      <details class="remote-saved-host" data-remote-saved-host>
        <summary>${msg("remoteTools.savedHostKey")}</summary>
        <code>${escapeHtml(profile.hostKey)}</code>
        <button type="button" class="wb-button" data-remote-recheck>${msg("remoteTools.recheckHost")}</button>
      </details>`
          : ""
      }
      </div>
      <section hidden data-remote-review class="remote-key-review" aria-labelledby="remote-review-title">
        <h3 id="remote-review-title" tabindex="-1">${msg("remoteTools.reviewHostKey")}</h3>
        <p class="remote-key-address" data-remote-address></p>
        <dl>
          <div data-remote-previous hidden>
            <dt>${msg("remoteTools.savedHostKey")}</dt><dd><code>${escapeHtml(profile?.hostKey ?? "")}</code></dd>
          </div>
          <div>
            <dt>${msg("remoteTools.hostKey")}</dt><dd><code data-remote-key></code></dd>
          </div>
        </dl>
        <p class="wb-help" data-remote-review-help></p>
      </section>
      <p data-remote-editor-error role="alert" hidden></p>
      </div>
      <footer class="remote-editor-actions">
        ${profile ? `<button type="button" class="wb-button danger" data-remote-remove>${msg("remoteTools.remove")}</button>` : ""}
        <div class="confirmation-actions remote-editor-submit-actions">
        <button type="button" class="wb-button" data-remote-back hidden>${msg("remoteTools.editHostDetails")}</button>
        <button type="button" class="wb-button" data-remote-cancel>${msg("common.cancel")}</button>
        <button type="submit" class="wb-button primary">${msg("common.save")}</button>
        </div>
      </footer>
    </form>`,
  );
  const form = requireElement("form", dialog) as HTMLFormElement,
    submit = requireElement('button[type="submit"]', form) as HTMLButtonElement,
    selector = requireElement("select", form) as HTMLSelectElement,
    password = requireElement('input[name="ssh-password"]', form) as HTMLInputElement,
    key = requireElement('textarea[name="ssh-privateKey"]', form) as HTMLTextAreaElement,
    phrase = requireElement('input[name="ssh-passphrase"]', form) as HTMLInputElement,
    cancel = requireElement("[data-remote-cancel]", form) as HTMLButtonElement,
    remove = form.querySelector<HTMLButtonElement>("[data-remote-remove]"),
    error = requireElement("[data-remote-editor-error]", form) as HTMLElement;
  const fields = requireElement("[data-remote-fields]", form) as HTMLElement;
  const review = requireElement("[data-remote-review]", form) as HTMLElement;
  const reviewTitle = requireElement("#remote-review-title", review) as HTMLElement;
  const backToDetails = requireElement("[data-remote-back]", form) as HTMLButtonElement;
  const saved = fields.querySelector<HTMLElement>("[data-remote-saved-host]");
  const recheck = fields.querySelector<HTMLButtonElement>("[data-remote-recheck]");
  const name = requireElement("#remote-field-name", fields) as HTMLInputElement;
  const host = requireElement("#remote-field-host", fields) as HTMLInputElement;
  const port = requireElement("#remote-field-port", fields) as HTMLInputElement;
  const username = requireElement("#remote-field-username", fields) as HTMLInputElement;
  const id = profile?.id ?? crypto.randomUUID();
  let pending = false;
  let candidate: RemoteHostKey | undefined;
  let confirmed: RemoteHostKey | undefined;
  let lastInput = "";
  let operationId = "";
  const lifetime = new AbortController();
  const controls = [submit, cancel, backToDetails, ...(remove ? [remove] : []), ...(recheck ? [recheck] : [])];
  const target = () => ({ host: host.value.trim().toLowerCase(), port: port.valueAsNumber });
  const matchesTarget = (key: RemoteHost | undefined) => key?.host === target().host && key?.port === target().port;
  const currentHostKey = () =>
    matchesTarget(confirmed) ? confirmed?.hostKey : matchesTarget(profile) ? profile?.hostKey : undefined;

  function render() {
    const reviewing = !!candidate;
    fields.hidden = reviewing;
    review.hidden = !reviewing;
    submit.formNoValidate = reviewing;
    cancel.hidden = reviewing;
    backToDetails.hidden = !reviewing;
    if (remove) remove.hidden = reviewing;
    if (saved) saved.hidden = !matchesTarget(profile);
    const usePassword = selector.value === "password";
    const needsCredential =
      !profile ||
      profile.method !== selector.value ||
      !matchesTarget(profile) ||
      profile.username !== username.value.trim() ||
      currentHostKey() !== profile.hostKey;
    for (const [kind, active] of [
      ["password", usePassword],
      ["privateKey", !usePassword],
    ] as const) {
      const group = requireElement(`[data-remote-credential="${kind}"]`, fields) as HTMLElement;
      group.hidden = !active;
    }
    password.required = !reviewing && usePassword && needsCredential;
    key.required = !reviewing && !usePassword && needsCredential;
    password.disabled = reviewing || !usePassword;
    key.disabled = phrase.disabled = reviewing || usePassword;
    localizeText(
      submit,
      reviewing ? "remoteTools.confirmHostKey" : currentHostKey() ? "common.save" : "remoteTools.readHostKey",
      undefined,
      t,
    );
  }
  function showError(message: MessageId) {
    error.hidden = false;
    localizeText(error, message, undefined, t);
  }
  async function run(button: HTMLButtonElement, label: MessageId, work: () => Promise<void>) {
    if (pending) return;
    pending = true;
    error.hidden = true;
    const width = button.getBoundingClientRect().width;
    for (const action of controls) action.disabled = true;
    button.style.minInlineSize = width + "px";
    setMessageHtml(button, busyIndicator);
    button.setAttribute("aria-label", t(label));
    button.setAttribute("aria-busy", "true");
    try {
      await work();
    } catch (cause) {
      if (dialog.open) showError(cause instanceof RemoteApiError ? cause.messageId : "remoteTools.unavailable");
    } finally {
      pending = false;
      if (dialog.open) {
        for (const action of controls) action.disabled = false;
        button.style.removeProperty("min-inline-size");
        button.removeAttribute("aria-label");
        button.removeAttribute("aria-busy");
        if (button === recheck) localizeText(button, "remoteTools.recheckHost", undefined, t);
        if (button === remove) localizeText(button, "remoteTools.remove", undefined, t);
        render();
      }
    }
  }
  function readHostKey(button: HTMLButtonElement) {
    void run(button, "remoteTools.readingHostKey", async () => {
      const received = await remoteApi.hostKey(target(), lifetime.signal);
      if (!dialog.open || !matchesTarget(received)) return;
      const changed = !!profile && matchesTarget(profile) && profile.hostKey !== received.hostKey;
      candidate = received;
      requireElement("[data-remote-previous]", review).toggleAttribute("hidden", !changed);
      requireElement("[data-remote-key]", review).textContent = received.hostKey;
      requireElement("[data-remote-address]", review).textContent =
        (received.host.includes(":") ? `[${received.host}]` : received.host) + ":" + received.port;
      localizeText(
        requireElement("[data-remote-review-help]", review),
        changed ? "remoteTools.changedHostKeyHelp" : "remoteTools.reviewHostKeyHelp",
        undefined,
        t,
      );
      review.hidden = false;
      reviewTitle.focus();
    });
  }
  function editDetails() {
    candidate = undefined;
    error.hidden = true;
    render();
    host.focus();
  }
  function done() {
    dialog.close();
    change();
  }
  for (const input of [host, port, username])
    input.addEventListener("input", () => {
      if (input !== username && confirmed && !matchesTarget(confirmed)) confirmed = undefined;
      if (!pending) render();
    });
  selector.onchange = render;
  cancel.onclick = () => dialog.close();
  backToDetails.onclick = editDetails;
  if (recheck) recheck.onclick = () => readHostKey(recheck);
  dialog.addEventListener("cancel", (event) => {
    if (pending || candidate) event.preventDefault();
    if (!pending && candidate) editDetails();
  });
  dialog.addEventListener(
    "close",
    () => {
      lifetime.abort();
      lastInput = password.value = key.value = phrase.value = "";
      dialog.remove();
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    },
    { once: true },
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    if (pending) return;
    const hostKey = candidate?.hostKey ?? currentHostKey();
    if (!hostKey) return readHostKey(submit);
    const credential: RemoteCredential | undefined =
      selector.value === "password"
        ? password.value
          ? { method: "password", password: password.value }
          : undefined
        : key.value
          ? { method: "privateKey", privateKey: key.value, passphrase: phrase.value }
          : undefined;
    if (candidate && profile && candidate.hostKey !== profile.hostKey && !credential) {
      confirmed = candidate;
      editDetails();
      showError("remoteTools.missingCredential");
      (selector.value === "password" ? password : key).focus();
      return;
    }
    const data: Omit<RemoteConnectionInput, "operationId"> = {
      id,
      version: profile?.version ?? 0,
      name: name.value,
      ...target(),
      username: username.value,
      hostKey,
      credential,
    };
    const signature = JSON.stringify(data);
    if (signature !== lastInput) {
      operationId = crypto.randomUUID();
      lastInput = signature;
    }
    void run(submit, "remoteTools.saving", async () => {
      await remoteApi.save({ ...data, operationId });
      done();
    });
  };
  if (remove && profile)
    remove.onclick = async () => {
      if (
        await confirmAction({
          title: "remoteTools.remove",
          message: "remoteTools.removeConfirm",
          values: { name: profile.name },
          confirmText: "remoteTools.remove",
          cancelText: "common.cancel",
        })
      )
        void run(remove, "remoteTools.saving", async () => {
          await remoteApi.remove(profile);
          done();
        });
    };
  render();
  document.body.append(dialog);
  dialog.showModal();
  return () => dialog.close();
}
