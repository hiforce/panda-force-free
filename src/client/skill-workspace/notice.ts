import type { Translate } from "../../shared/i18n/messages.js";
import { errorText } from "../i18n.js";
import { PluginApiError } from "../plugins/api.js";
import type { SkillWorkspaceClient } from "./client.js";
export function showWorkspaceNotice(host: HTMLElement, client: SkillWorkspaceClient, t: Translate) {
  const show = client.busy || Boolean(client.error) || Boolean(client.pending);
  host.hidden = !show;
  const message = host.querySelector<HTMLElement>("p")!;
  message.textContent = client.busy
    ? t("skillWorkspace.saving")
    : client.pending
      ? t("skillWorkspace.uncertain")
      : errorText(
          client.error instanceof PluginApiError ? client.error.payload : null,
          t,
          "skillWorkspace.unavailable",
        );
  const retry = host.querySelector<HTMLButtonElement>("button")!;
  retry.hidden = client.busy;
  retry.disabled = client.busy;
}
