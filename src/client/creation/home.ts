import type { Translate } from "../../shared/i18n/messages.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { CreationActivity } from "./activity.js";

export function createCreationHome(
  t: Translate,
  identity: string,
  projects: () => { id: string; name: string }[],
  navigate: (path: string) => void,
) {
  const root = document.createElement("section"),
    header = document.createElement("header"),
    body = document.createElement("div"),
    historyRoot = document.createElement("div");
  root.className = "creation-home";
  body.className = "creation-history-page";
  header.className = "creation-home-heading";
  root.append(header, body);
  let history: CreationActivity | undefined;

  function hide() {
    history?.hide();
  }

  function show(host: HTMLElement) {
    if (root.parentElement !== host) {
      host.replaceChildren(root);
      setMessageHtml(
        header,
        `<h1 tabindex="-1">${messageHtml("creation.activityTitle", {}, t)}</h1><nav><a class="wb-button" href="/create">${codexIcon("plus")}${messageHtml("creation.newCreation", {}, t)}</a><a class="icon-button" href="/create?view=works" ${messageAttributes("aria-label", "creative.assetLibrary", {}, t)} ${messageAttributes("title", "creative.assetLibrary", {}, t)}>${codexIcon("folderOpen")}</a></nav>`,
      );
      body.append(historyRoot);
      history ??= new CreationActivity(historyRoot, t, identity, projects, navigate, {
        limit: 12,
        presentation: "list",
      });
      header.querySelector("h1")!.focus({ preventScroll: true });
    }
    history?.show();
  }
  return { show, hide };
}
