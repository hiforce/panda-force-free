import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { getBrowserI18n, messageHtml as h, setMessageHtml } from "../i18n.js";
import { usersRequest } from "./api.js";
import { beginPasswordRecovery } from "./recovery.js";

interface Member {
  id: string;
  email?: string;
  username?: string;
  role: "admin" | "member";
  enabled: boolean;
  activated?: boolean;
  installation?: boolean;
  revision: number;
  invitation?: { state: "pending" | "sending" | "sent" | "failed" };
}
interface Self {
  id: string;
  username: string;
  email: string | null;
  role: "admin" | "member";
  smtpConfigured: boolean;
  pending?: Member | null;
}
interface Mail {
  revision: number;
  configured: boolean;
  host?: string;
  port?: number;
  security?: string;
  username?: string;
  passwordSet?: boolean;
  from?: string;
  publicUrl?: string;
  ca?: string;
}

/** Settings retain draft fields and scroll position; only the owned member list is refreshed in the background. */
export function createUsersSettings(t: Translate) {
  let host: HTMLElement | null = null,
    self: Self | null = null,
    mail: Mail | null = null,
    members: Member[] = [],
    closing = new AbortController(),
    timer: ReturnType<typeof setInterval> | undefined,
    busy = false,
    rendered = false,
    refreshing: Promise<void> | null = null,
    reading: AbortController | null = null,
    epoch = 0;
  let inviteOperation = crypto.randomUUID(),
    bindOperation = crypto.randomUUID();
  const get = <T extends HTMLElement>(selector: string) => host?.querySelector<T>(selector) ?? null;
  const copy = (id: MessageId) => h(id, {}, t);
  const field = (id: string, name: string, type = "text", value = "", required = true) =>
    `<label class="wb-field"><span>${copy(id as MessageId)}</span><input name="${name}" type="${type}" value="${e(value)}" ${required ? "required" : ""} ${type === "password" ? 'autocomplete="new-password"' : ""}></label>`;
  const notice = (message: string, retry = false) => {
    const target = get("[data-users-notice]");
    if (target) target.textContent = message;
    const button = get<HTMLButtonElement>("[data-users-retry]");
    if (button) button.hidden = !retry;
  };
  const api = <T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal) =>
    usersRequest<T>(
      t,
      "/api/local-users" + path,
      method,
      body,
      AbortSignal.any([closing.signal, signal ?? AbortSignal.timeout(method === "GET" ? 10000 : 35000)]),
    );
  function controls() {
    host?.setAttribute("aria-busy", String(busy || (!rendered && Boolean(refreshing))));
    const retry = get<HTMLButtonElement>("[data-users-retry]");
    if (retry) retry.disabled = busy || Boolean(refreshing);
    for (const item of host?.querySelectorAll<HTMLFieldSetElement>("fieldset") ?? []) item.disabled = busy;
    for (const button of host?.querySelectorAll<HTMLButtonElement>("[data-requires-smtp]") ?? [])
      button.disabled = busy || !self?.smtpConfigured;
  }
  function paintMembers() {
    const target = get("[data-users-list]");
    if (!target || !self) return;
    setMessageHtml(
      target,
      members
        .map((member) => {
          const immutable = member.installation || member.id === self!.id;
          const state = !member.enabled
            ? "users.disabled"
            : member.activated || member.installation
              ? "users.active"
              : `users.${member.invitation?.state ?? "pending"}`;
          return `<article class="users-member"><div class="users-member-copy"><strong data-i18n-ignore>${e(member.email ?? member.username ?? "")}</strong><small>${copy(state as MessageId)}${member.installation ? " · " + copy("users.installation") : ""}</small></div><div class="users-member-actions wb-form"><label class="wb-field"><span class="sr-only">${copy("users.role")}</span><select data-member-role="${e(member.id)}" ${immutable ? "disabled" : ""}>${["member", "admin"].map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${copy(role === "admin" ? "users.admin" : "users.member")}</option>`).join("")}</select></label>${immutable ? "" : `<button type="button" class="wb-button" data-member-toggle="${e(member.id)}">${copy(member.enabled ? "users.disable" : "users.enable")}</button>`}${!member.installation && !member.activated && member.enabled ? `<button type="button" class="wb-button" data-member-resend="${e(member.id)}">${copy("users.resend")}</button>` : ""}</div></article>`;
        })
        .join(""),
    );
  }
  function paintProfile() {
    const email = get("[data-users-current-email]");
    if (email) email.textContent = self?.email ?? t("users.notBound");
    const pending = get("[data-users-binding-state]");
    if (pending)
      pending.textContent = self?.pending?.invitation ? t(("users." + self.pending.invitation.state) as MessageId) : "";
    for (const item of host?.querySelectorAll<HTMLElement>("[data-users-smtp-required]") ?? [])
      item.hidden = Boolean(self?.smtpConfigured);
    controls();
  }
  function refresh() {
    if (refreshing) return refreshing;
    if (!host || closing.signal.aborted) return Promise.resolve();
    const controller = new AbortController();
    reading = controller;
    const work = load(controller).finally(() => {
      controller.abort();
      if (refreshing === work) {
        refreshing = null;
        reading = null;
        controls();
      }
    });
    refreshing = work;
    controls();
    return work;
  }
  async function load(controller: AbortController) {
    const current = epoch;
    const signal = AbortSignal.any([controller.signal, closing.signal, AbortSignal.timeout(10000)]);
    if (!rendered) notice(t("common.loading"), true);
    try {
      const next = await api<Self>("/self", "GET", undefined, signal);
      if (current !== epoch || signal.aborted) return;
      if (next.role === "admin") {
        const [settings, list] = await Promise.all([
          rendered ? Promise.resolve(mail) : api<Mail>("/mail", "GET", undefined, signal),
          api<{ users: Member[] }>("", "GET", undefined, signal),
        ]);
        if (current !== epoch || signal.aborted) return;
        if (!rendered) mail = settings;
        members = list.users;
      }
      self = next;
      if (!rendered) {
        render();
        rendered = true;
      } else {
        paintProfile();
        paintMembers();
      }
      notice("");
    } catch (error) {
      if (current === epoch && !controller.signal.aborted && !closing.signal.aborted)
        notice(signal.aborted || !(error instanceof Error) ? t("users.unavailable") : error.message, true);
    }
  }
  async function execute(work: () => Promise<void>, success?: MessageId) {
    if (busy || !host) return;
    const current = epoch;
    busy = true;
    controls();
    notice("");
    try {
      reading?.abort();
      await refreshing;
      await work();
      if (current !== epoch) return;
      await refresh();
      if (success) notice(t(success));
    } catch (error) {
      if (current === epoch && !closing.signal.aborted)
        notice(error instanceof Error ? error.message : t("users.unavailable"));
    } finally {
      if (current === epoch) {
        busy = false;
        controls();
      }
    }
  }
  const retryButton = () =>
    `<button type="button" class="wb-button" data-users-retry hidden>${copy("common.retry")}</button>`;
  function render() {
    if (!host || !self) return;
    const root = self.id === "installation",
      admin = self.role === "admin";
    const smtp = mail ?? { revision: 0, configured: false };
    setMessageHtml(
      host,
      `<div class="users-settings"><p role="status" data-users-notice></p>${retryButton()}<section class="users-section"><h2>${copy("users.profile")}</h2><p data-i18n-ignore>${e(self.username)}</p><p data-users-current-email></p>${root ? `<p class="users-hint">${copy("users.bindHint")}</p><form class="wb-form" data-users-bind><fieldset>${field("users.email", "email", "email")}<button class="wb-button primary" type="submit" data-requires-smtp>${copy("users.bindEmail")}</button></fieldset></form><p role="status" data-users-binding-state></p>` : ""}<p class="users-hint" data-users-smtp-required>${copy("users.smtpRequired")}</p><button type="button" class="wb-button" data-users-reset data-requires-smtp>${copy("users.requestReset")}</button></section>${admin ? `<section class="users-section"><h2>${copy("users.members")}</h2><form class="wb-form" data-users-invite><fieldset class="users-invite-fields">${field("users.email", "email", "email")}<label class="wb-field"><span>${copy("users.role")}</span><select name="role"><option value="member">${copy("users.member")}</option><option value="admin">${copy("users.admin")}</option></select></label><button type="submit" class="wb-button primary" data-requires-smtp>${copy("users.invite")}</button></fieldset></form><div data-users-list></div></section><section class="users-section"><details ${smtp.configured ? "" : "open"}><summary><strong>${copy("users.smtpTitle")}</strong></summary><form class="wb-form" data-users-mail><fieldset><div class="users-mail-grid">${field("users.host", "host", "text", smtp.host ?? "")}${field("users.port", "port", "number", String(smtp.port ?? 587))}<label class="wb-field"><span>${copy("users.security")}</span><select name="security"><option value="starttls" ${smtp.security === "starttls" ? "selected" : ""}>${copy("users.starttls")}</option><option value="tls" ${smtp.security === "tls" ? "selected" : ""}>${copy("users.tls")}</option></select></label>${field("users.from", "from", "email", smtp.from ?? "")}${field("users.smtpUsername", "username", "text", smtp.username ?? "", false)}${field("users.smtpPassword", "password", "password", "", false)}${field("users.publicUrl", "publicUrl", "url", smtp.publicUrl ?? location.origin)}</div><p class="users-hint">${copy("users.keepPassword")}</p><details><summary>${copy("users.advanced")}</summary><label class="wb-field"><span>${copy("users.ca")}</span><textarea name="ca" rows="4">${e(smtp.ca ?? "")}</textarea></label></details><button type="submit" class="wb-button primary">${copy("users.saveTest")}</button></fieldset></form></details></section>` : ""}</div>`,
    );
    paintMembers();
    paintProfile();
    get<HTMLFormElement>("[data-users-invite]")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement,
          fields = new FormData(form);
        void execute(async () => {
          await api("", "POST", { email: fields.get("email"), role: fields.get("role"), operationId: inviteOperation });
          inviteOperation = crypto.randomUUID();
          form.reset();
        }, "users.inviteQueued");
      },
      { signal: closing.signal },
    );
    get<HTMLFormElement>("[data-users-bind]")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        void execute(async () => {
          await api("/email", "POST", { email: new FormData(form).get("email"), operationId: bindOperation });
          bindOperation = crypto.randomUUID();
        }, "users.bindQueued");
      },
      { signal: closing.signal },
    );
    get<HTMLFormElement>("[data-users-mail]")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement,
          fields = Object.fromEntries(new FormData(form));
        void execute(async () => {
          mail = await api<Mail>("/mail", "PUT", {
            ...fields,
            revision: mail?.revision ?? 0,
            port: Number(fields.port),
          });
          form.querySelector<HTMLInputElement>('input[name="password"]')!.value = "";
        }, "users.smtpSaved");
      },
      { signal: closing.signal },
    );
    get("[data-users-reset]")?.addEventListener("click", () => beginPasswordRecovery(self!.username, true), {
      signal: closing.signal,
    });
    get("[data-users-list]")?.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "[data-member-toggle],[data-member-resend]",
        );
        if (!button) return;
        const member = members.find((item) => item.id === (button.dataset.memberToggle ?? button.dataset.memberResend));
        if (!member) return;
        void execute(async () => {
          if (button.dataset.memberResend)
            await api("/resend", "POST", {
              id: member.id,
              revision: member.revision,
              operationId: crypto.randomUUID(),
            });
          else await api("/update", "POST", { id: member.id, revision: member.revision, enabled: !member.enabled });
        });
      },
      { signal: closing.signal },
    );
    get("[data-users-list]")?.addEventListener(
      "change",
      (event) => {
        const select = event.target as HTMLSelectElement,
          member = members.find((item) => item.id === select.dataset.memberRole);
        if (member)
          void execute(async () => {
            await api("/update", "POST", { id: member.id, revision: member.revision, role: select.value });
          });
      },
      { signal: closing.signal },
    );
  }
  function hide() {
    epoch++;
    closing.abort();
    reading?.abort();
    reading = null;
    refreshing = null;
    rendered = false;
    busy = false;
    closing = new AbortController();
    if (timer) clearInterval(timer);
    for (const password of host?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? [])
      password.value = "";
    host = null;
  }
  function show(element: HTMLElement) {
    hide();
    host = element;
    self = null;
    mail = null;
    members = [];
    setMessageHtml(host, `<p role="status" data-users-notice>${e(t("common.loading"))}</p>${retryButton()}`);
    host.addEventListener(
      "click",
      (event) => {
        if ((event.target as Element).closest("[data-users-retry]")) void refresh();
      },
      { signal: closing.signal },
    );
    void refresh();
    timer = setInterval(() => {
      if (!busy) void refresh();
    }, 5000);
  }
  getBrowserI18n().subscribe(() => {
    if (host && self) {
      const forms = [...host.querySelectorAll<HTMLFormElement>("form")].map((form) => ({
        selector: form.hasAttribute("data-users-mail")
          ? "[data-users-mail]"
          : form.hasAttribute("data-users-bind")
            ? "[data-users-bind]"
            : "[data-users-invite]",
        values: [...new FormData(form)],
      }));
      render();
      for (const form of forms)
        for (const [key, value] of form.values) {
          const control = get<HTMLInputElement>(`${form.selector} [name="${key}"]`);
          if (control && typeof value === "string") control.value = value;
        }
    }
  });
  return { show, hide };
}
