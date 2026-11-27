import type { Translate } from "../../shared/i18n/messages.js";
import type { ContentAccessView, ContentGrantSnapshot } from "../../shared/content-access.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { contentAccessRequest } from "./api.js";

export function contentAccessSettingsHtml(view: ContentAccessView, t: Translate) {
  const roles = (["reader", "contributor", "blocked", "inherit"] as const)
    .map(
      (role) =>
        `<option value="${role}">${e(t(role === "reader" ? "cli.accessReader" : role === "contributor" ? "cli.accessContributor" : role === "blocked" ? "cli.accessBlocked" : "cli.accessInherit"))}</option>`,
    )
    .join("");
  return `<details class="cli-settings-section" data-content-access><summary>${e(t("cli.projectAccess"))}</summary><div class="content-access-body"><p>${e(t("cli.accessBoundary"))}</p>
 <div class="wb-field"><span>${e(t("cli.memberId"))}</span><code class="content-access-identity" data-access-self data-i18n-ignore>${e(view.owner)}</code></div><div class="resource-actions"><button type="button" class="wb-button" data-access-copy>${e(t("cli.copyMemberId"))}</button></div>
 <p>${e(t(view.mode === "restricted" ? "cli.accessRestricted" : "cli.accessShared"))}</p><p data-access-notice role="status" aria-live="polite"></p>${
   !view.administrator
     ? `<p>${e(t("cli.accessManaged"))}</p>`
     : `<p>${e(t("cli.accessAdminHint"))}</p>${
         !view.projects.length
           ? `<p>${e(t("cli.accessNoProjects"))}</p>`
           : `<label class="wb-field"><span>${e(t("cli.accessProject"))}</span><select data-access-project>${view.projects.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join("")}</select></label>
 <form data-access-form class="wb-form"><fieldset disabled class="content-access-editor" data-access-fields><div class="wb-form-grid"><label class="wb-field"><span>${e(t("cli.memberId"))}</span><input name="pf-access-owner" required pattern="[a-f0-9]{64}" maxlength="64" autocomplete="off"></label><label class="wb-field"><span>${e(t("cli.accessRole"))}</span><select name="pf-access-role">${roles}</select></label></div><div class="resource-actions"><button type="submit" class="wb-button">${e(t("cli.accessSave"))}</button></div></fieldset></form>
 <div class="resource-actions"><button type="button" class="wb-button" data-access-reload>${e(t("cli.accessReload"))}</button></div><ul class="content-access-grants" data-access-grants></ul>`
       }`
 }</div></details>`;
}

/** Grant editing has a separate request lifetime and never retains registration secrets or silently replays a conflict. */
export function bindContentAccessSettings(
  host: HTMLElement,
  view: ContentAccessView,
  t: Translate,
  signal: AbortSignal,
) {
  const root = host.querySelector<HTMLElement>("[data-content-access]")!,
    get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!,
    notice = (text: string) => {
      if (!signal.aborted) get("[data-access-notice]").textContent = text;
    };
  let read = new AbortController(),
    epoch = 0,
    revision: number | null = null,
    busy = false;
  const selected = () => get<HTMLSelectElement>("[data-access-project]").value;
  const error = (value: unknown) =>
    notice(t(value instanceof Error && value.message === "conflict" ? "cli.accessConflict" : "cli.accessUnavailable"));
  async function load() {
    read.abort();
    read = new AbortController();
    const current = ++epoch,
      project = selected();
    revision = null;
    get<HTMLFieldSetElement>("[data-access-fields]").disabled = true;
    get("[data-access-grants]").replaceChildren();
    notice(t("cli.working"));
    try {
      const snapshot = await contentAccessRequest<ContentGrantSnapshot>(
        "/grants?" + new URLSearchParams({ project }),
        "GET",
        undefined,
        AbortSignal.any([signal, read.signal]),
      );
      if (signal.aborted || current !== epoch) return false;
      revision = snapshot.revision;
      setMessageHtml(
        get("[data-access-grants]"),
        snapshot.grants.length
          ? snapshot.grants
              .map((grant) => {
                const creator = grant.owner === snapshot.projectOwner;
                const label = creator
                  ? "projects.projectOwner"
                  : grant.role === "reader"
                    ? "cli.accessReader"
                    : grant.role === "contributor"
                      ? "cli.accessContributor"
                      : "cli.accessBlocked";
                return `<li><code data-i18n-ignore>${e(grant.owner)}</code><div class="resource-actions"><span>${e(t(label))}</span>${creator ? "" : `<button type="button" class="wb-button" data-access-edit="${e(grant.owner)}" data-access-role="${grant.role}">${e(t("cli.accessEdit"))}</button>`}</div></li>`;
              })
              .join("")
          : `<li>${e(t("cli.accessNoOverrides"))}</li>`,
      );
      get<HTMLFieldSetElement>("[data-access-fields]").disabled = false;
      notice("");
      return true;
    } catch (value) {
      if (!signal.aborted && current === epoch) error(value);
      return false;
    }
  }
  root.addEventListener(
    "click",
    (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button");
      if (!button) return;
      if (button.hasAttribute("data-access-copy"))
        void navigator.clipboard
          .writeText(view.owner)
          .then(() => notice(t("cli.memberIdCopied")))
          .catch(error);
      if (button.hasAttribute("data-access-reload") && !busy) void load();
      if (button.dataset.accessEdit && !busy) {
        get<HTMLInputElement>('[name="pf-access-owner"]').value = button.dataset.accessEdit;
        get<HTMLSelectElement>('[name="pf-access-role"]').value = button.dataset.accessRole!;
        get<HTMLInputElement>('[name="pf-access-owner"]').focus();
      }
    },
    { signal },
  );
  if (!view.administrator || !view.projects.length) return;
  root.addEventListener(
    "toggle",
    () => {
      if ((root as HTMLDetailsElement).open && revision === null && !busy) void load();
    },
    { signal },
  );
  get<HTMLSelectElement>("[data-access-project]").addEventListener(
    "change",
    () => {
      if (!busy) void load();
    },
    { signal },
  );
  get<HTMLFormElement>("[data-access-form]").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (busy || revision === null) return;
      const project = selected(),
        expected = revision,
        owner = get<HTMLInputElement>('[name="pf-access-owner"]').value,
        role = get<HTMLSelectElement>('[name="pf-access-role"]').value;
      busy = true;
      revision = null;
      get<HTMLFieldSetElement>("[data-access-fields]").disabled = true;
      get<HTMLSelectElement>("[data-access-project]").disabled = true;
      notice(t("cli.working"));
      void contentAccessRequest(
        "/grants",
        "PUT",
        { project, owner, role: role === "inherit" ? null : role, revision: expected },
        signal,
      )
        .then(async () => {
          if (!signal.aborted && (await load())) {
            notice(t("cli.accessSaved"));
          }
        })
        .catch((value) => {
          if (!signal.aborted) error(value);
        })
        .finally(() => {
          busy = false;
          if (!signal.aborted) get<HTMLSelectElement>("[data-access-project]").disabled = false;
        });
    },
    { signal },
  );
}
