import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SocialAccount, SocialAccountInput } from "../../shared/connections/accounts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml as m, errorText } from "../i18n.js";

import { accountsApi, AccountApiError } from "./api.js";
import { accountFrame, accountForm } from "./views.js";

/** Explicit user actions own requests; background publication polling never redraws account forms. */
export class AccountEditor {
  private root: HTMLElement | null = null;
  private epoch = 0;
  private items: SocialAccount[] = [];
  private project = "";
  private selected = "";
  private busy = false;
  private replace = false;
  private pending = crypto.randomUUID();
  constructor(private t: Translate) {}
  close() {
    this.epoch++;
    if (this.root) this.root.replaceChildren();
    this.root = null;
  }
  async mount(root: HTMLElement, project: string, selectedId?: string) {
    this.close();
    this.root = root;
    this.project = project;
    this.selected = "";
    this.items = [];
    this.busy = false;
    this.replace = false;
    this.pending = crypto.randomUUID();
    setMessageHtml(root, accountFrame(this.t));
    const epoch = this.epoch;
    this.notice(this.t("delivery.loading"));
    try {
      const { accounts } = await accountsApi.list(project);
      if (epoch !== this.epoch) return;
      this.items = accounts;
      this.selected =
        selectedId === undefined
          ? accounts[0]?.id || ""
          : accounts.some((item) => item.id === selectedId)
            ? selectedId
            : "";
      this.draw();
      this.notice("");
    } catch (error) {
      if (epoch === this.epoch) this.report(error);
    }
  }
  private notice(value: string) {
    const node = this.root?.querySelector<HTMLElement>("#socialAccountNotice");
    if (node) {
      node.textContent = value;
      node.hidden = !value;
    }
  }
  private report(error: unknown) {
    this.notice(
      errorText(error instanceof AccountApiError ? error.payload : null, this.t, "accounts.authorizationUnavailable"),
    );
  }
  private draw() {
    const root = this.root;
    if (!root) return;
    const account = this.items.find((item) => item.id === this.selected) || null,
      picker = root.querySelector<HTMLSelectElement>("#socialAccountPicker")!;
    setMessageHtml(
      picker,
      `<option value="">${m("accounts.new", undefined, this.t)}</option>` +
        this.items.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join(""),
    );
    picker.value = this.selected;
    picker.onchange = () => {
      this.selected = picker.value;
      this.replace = false;
      this.pending = crypto.randomUUID();
      this.notice("");
      this.draw();
    };
    const target = root.querySelector<HTMLElement>("#socialAccountForm")!;
    setMessageHtml(
      target,
      accountForm(this.t, account, new URL("/api/publication-accounts/x/callback", location.origin).href, this.replace),
    );
    const form = target.querySelector<HTMLFormElement>("form")!;
    form.onsubmit = (event) => {
      event.preventDefault();
      const fields = new FormData(form),
        secret = String(fields.get("clientSecret") || "");
      const application: SocialAccountInput["application"] = {
        clientId: String(fields.get("clientId") || ""),
        callbackUrl: String(fields.get("callback") || ""),
        ...(secret ? { clientSecret: secret } : {}),
      };
      void this.perform(async () => {
        const result = account
          ? await accountsApi.update(account.id, {
              version: account.version,
              name: String(fields.get("name")),
              enabled: fields.get("enabled") === "on",
              ...(!account || this.replace ? { application } : {}),
            })
          : await accountsApi.create({
              id: this.pending,
              projectId: this.project,
              name: String(fields.get("name")),
              provider: "x",
              application,
            });
        return result.account;
      }, "accounts.saved");
    };
    for (const button of target.querySelectorAll<HTMLButtonElement>("[data-account-action]"))
      button.onclick = () => {
        if (this.busy) return;
        const action = button.dataset.accountAction;
        if (!account) {
          if (action === "refresh")
            void this.perform(async () => (await accountsApi.detail(this.pending)).account, "accounts.refreshed");
          return;
        }
        if (action === "configure") {
          this.replace = true;
          this.draw();
          root.querySelector<HTMLInputElement>("#account-clientId")?.focus({ preventScroll: true });
          return;
        }
        void this.perform(
          async () => {
            if (action === "refresh") return (await accountsApi.detail(account.id)).account;
            if (action === "disconnect") return (await accountsApi.disconnect(account.id, account.version)).account;
            if (action === "authorize") {
              const epoch = this.epoch,
                { authorization } = await accountsApi.authorize(account.id, account.version);
              if (epoch === this.epoch) {
                const url = new URL(authorization.url);
                if (url.origin !== "https://x.com" || url.pathname !== "/i/oauth2/authorize")
                  throw new Error("Invalid authorization destination");
                location.assign(url.href);
              }
            }
            return null;
          },
          action === "authorize" ? "accounts.authorizeHint" : "accounts.refreshed",
        );
      };
  }
  private async perform(operation: () => Promise<SocialAccount | null>, message: MessageId) {
    if (this.busy || !this.root) return;
    this.busy = true;
    const epoch = this.epoch,
      root = this.root;
    const controls = () =>
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select");
    controls().forEach((element) => {
      element.disabled = true;
    });
    this.notice(this.t("delivery.working"));
    try {
      const account = await operation();
      if (epoch !== this.epoch) return;
      if (account) {
        this.items = [account, ...this.items.filter((item) => item.id !== account.id)];
        this.selected = account.id;
        this.pending = crypto.randomUUID();
        this.replace = false;
        this.draw();
      }
      this.notice(this.t(message));
    } catch (error) {
      if (epoch === this.epoch) this.report(error);
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        controls().forEach((element) => {
          element.disabled = false;
        });
      }
    }
  }
}
