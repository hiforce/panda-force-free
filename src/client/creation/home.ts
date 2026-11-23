import type { Translate } from "../../shared/i18n/messages.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { CreationActivity } from "./activity.js";

export function createCreationHome(
  t: Translate,
  library: { show(host: HTMLElement): void; hide(): void },
  identity: string,
  projects: () => { id: string; name: string }[],
  navigate: (path: string) => void,
) {
  const root = document.createElement("section"),
    header = document.createElement("header"),
    body = document.createElement("div"),
    historyRoot = document.createElement("div");
  root.className = "creation-home";
  header.className = "creation-home-heading";
  root.append(header, body);
  let history: CreationActivity | undefined, mode: "activity" | "works" | undefined;

  function hide() {
    history?.hide();
    if (mode === "works") library.hide();
    mode = undefined;
  }

  function show(host: HTMLElement) {
    const activity = new URL(location.href).searchParams.get("view") === "activity",
      next = activity ? "activity" : "works",
      title = activity ? "creation.activityTitle" : "creative.assetLibrary",
      changed = mode !== next || root.parentElement !== host;
    if (root.parentElement !== host) host.replaceChildren(root);
    if (changed) {
      hide();
      mode = next;
      body.replaceChildren();
      body.classList.toggle("creation-history-page", activity);
      setMessageHtml(
        header,
        `<h1 tabindex="-1">${messageHtml(title, {}, t)}</h1><nav><a class="wb-button" href="/create">${codexIcon("plus")}${messageHtml("creation.newCreation", {}, t)}</a>${activity ? `<a class="icon-button" href="/create?view=works" ${messageAttributes("aria-label", "creative.assetLibrary", {}, t)} ${messageAttributes("title", "creative.assetLibrary", {}, t)}>${codexIcon("folderOpen")}</a>` : `<a class="icon-button" href="/create?view=activity" ${messageAttributes("aria-label", "creation.activityTitle", {}, t)} ${messageAttributes("title", "creation.activityTitle", {}, t)}>${codexIcon("clock")}</a>`}</nav>`,
      );
      if (activity) {
        body.append(historyRoot);
        history ??= new CreationActivity(historyRoot, t, identity, projects, navigate, {
          limit: 12,
          presentation: "list",
        });
        header.querySelector("h1")!.focus({ preventScroll: true });
      }
    }
    if (activity) history?.show();
    else library.show(body);
  }
  return { show, hide };
}
