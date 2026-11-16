import type { Translate } from "../../shared/i18n/messages.js";
import type { CliRegistration } from "../../shared/cli/contracts.js";
import { request } from "../http-client.js";
import { setMessageHtml } from "../i18n.js";
import { cliSettingsView, clientCards, type ClientAccess } from "./settings-view.js";
import { readContentAccess } from "../content-access/api.js";
import { bindContentAccessSettings } from "../content-access/settings.js";
export function createCliSettings(t: Translate) {
  let host: HTMLElement | null = null,
    epoch = 0,
    controller = new AbortController(),
    busy = false,
    secret: { registration: CliRegistration; apiKey: string } | null = null;
  const field = <T extends HTMLElement>(selector: string) => host!.querySelector<T>(selector)!;
  const notice = (text: string) => {
    const target = host?.querySelector("[data-cli-notice]");
    if (target) target.textContent = text;
  };
  async function api<T>(method = "GET", body?: unknown): Promise<T> {
    const r = await request("/api/cli/clients", {
      method,
      signal: controller.signal,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const p = await r.json();
    if (!r.ok) throw new Error(String(p.error?.code ?? "unavailable"));
    return p;
  }
  async function list() {
    const current = epoch,
      result = await api<{ clients: ClientAccess[] }>();
    if (host && current === epoch) setMessageHtml(field("[data-cli-clients]"), clientCards(t, result.clients));
  }
  function clearSecret() {
    secret = null;
    if (host?.querySelector("[data-cli-key]")) {
      field<HTMLInputElement>("[data-cli-key]").value = "";
      field("[data-cli-secret]").hidden = true;
      field<HTMLButtonElement>("[data-cli-form] button[type=submit]").disabled = false;
    }
  }
  async function run(work: () => Promise<void>) {
    if (!host || busy) return;
    const current = epoch;
    busy = true;
    host.setAttribute("aria-busy", "true");
    notice(t("cli.working"));
    try {
      await work();
      if (host && current === epoch && host.querySelector("[data-cli-notice]")?.textContent === t("cli.working"))
        notice("");
    } catch (error) {
      if (host && current === epoch && !controller.signal.aborted) {
        const code = error instanceof Error ? error.message : "unavailable";
        notice(
          t(
            code === "invalidInput"
              ? "cli.invalidInput"
              : code === "forbidden"
                ? "cli.forbidden"
                : code === "notFound"
                  ? "cli.notFound"
                  : code === "limit"
                    ? "cli.limit"
                    : "cli.unavailable",
          ),
        );
      }
    } finally {
      if (host && current === epoch) {
        busy = false;
        host.removeAttribute("aria-busy");
      }
    }
  }
  return {
    show(element: HTMLElement) {
      clearSecret();
      host = element;
      host.classList.add("cli-settings", "wb-form");
      setMessageHtml(host, `<p data-cli-notice role="status" aria-live="polite"></p>`);
      epoch++;
      controller.abort();
      controller = new AbortController();
      busy = false;
      const current = epoch;
      void run(async () => {
        const access = await readContentAccess(controller.signal);
        if (!host || current !== epoch) return;
        setMessageHtml(host, cliSettingsView(t, access.projects, access));
        bindContentAccessSettings(host, access, t, controller.signal);
        await list();
        field<HTMLFormElement>("[data-cli-form]").onsubmit = (event) => {
          event.preventDefault();
          void run(async () => {
            const form = new FormData(event.currentTarget as HTMLFormElement),
              projects = form.getAll("pf-cli-project"),
              capabilities = form.getAll("pf-cli-capability");
            if (!projects.length || !capabilities.length) {
              notice(t("cli.scopeRequired"));
              return;
            }
            const issued = await api<{ registration: CliRegistration; apiKey: string }>("POST", {
              name: form.get("pf-cli-name"),
              kind: form.get("pf-cli-kind"),
              projects,
              capabilities,
              expiresInDays: Number(form.get("pf-cli-expiry")),
            });
            if (!host || current !== epoch) return;
            secret = issued;
            field<HTMLInputElement>("[data-cli-key]").value = issued.apiKey;
            field("[data-cli-secret]").hidden = false;
            field<HTMLButtonElement>("[data-cli-form] button[type=submit]").disabled = true;
            field("[data-cli-secret]").scrollIntoView({ block: "nearest" });
            await list();
          });
        };
        host.onclick = (event) => {
          const button = (event.target as Element).closest<HTMLButtonElement>("button");
          if (!button) return;
          if (button.hasAttribute("data-cli-refresh")) void run(list);
          if (button.dataset.cliRevoke)
            void run(async () => {
              await api("DELETE", { clientId: button.dataset.cliRevoke });
              await list();
            });
          if (button.hasAttribute("data-cli-done")) clearSecret();
          if (button.hasAttribute("data-cli-copy") && secret)
            void navigator.clipboard
              .writeText(secret.apiKey)
              .then(() => notice(t("cli.copied")))
              .catch(() => notice(t("cli.unavailable")));
          if (button.hasAttribute("data-cli-download") && secret) {
            const url = URL.createObjectURL(
                new Blob([JSON.stringify(secret.registration, null, 2) + "\n"], { type: "application/json" }),
              ),
              a = document.createElement("a");
            a.href = url;
            a.download = "panda-registration.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
          }
        };
      });
    },
    hide() {
      controller.abort();
      epoch++;
      clearSecret();
      if (host) {
        host.onclick = null;
        host.replaceChildren();
      }
      host = null;
      busy = false;
    },
  };
}
