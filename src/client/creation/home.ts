import type { ComposerMount } from "../../gadget/system/composer/host.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";

/** Creation requests remain reachable without downloading the optional asset-library workspace. */
export function createCreationHome(
  t: Translate,
  mount: ComposerMount,
  library: { show(host: HTMLElement): void; hide(): void },
  navigate: (path: string) => void,
) {
  const root = document.createElement("section"),
    header = document.createElement("header"),
    body = document.createElement("div");
  root.className = "creation-home";
  header.className = "creation-home-heading";
  root.append(header, body);
  let composer: ReturnType<ComposerMount> | null = null,
    mode = "",
    requested = "";
  function hide() {
    composer?.dispose();
    composer = null;
    library.hide();
    mode = "";
    requested = "";
  }
  function show(host: HTMLElement) {
    const params = new URL(location.href).searchParams,
      view = params.get("view") || (params.has("asset") ? "works" : "create"),
      next = view === "works" ? "works" : "create";
    if (root.parentElement !== host) host.replaceChildren(root);
    setMessageHtml(
      header,
      `<h1>${messageHtml("creative.create", {}, t)}</h1><nav><a class="wb-button" href="/create?view=activity" data-creation-home-activity>${codexIcon("clock")}${messageHtml("creation.activityTitle", {}, t)}</a><a class="wb-button" href="/create?view=works" data-creation-home-works>${codexIcon("folderOpen")}${messageHtml("creative.assetLibrary", {}, t)}</a></nav>`,
    );
    for (const link of header.querySelectorAll<HTMLAnchorElement>("a"))
      link.onclick = (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(link.getAttribute("href")!);
      };
    if (mode !== next) {
      hide();
      mode = next;
      body.replaceChildren();
      if (mode === "works") library.show(body);
      else composer = mount(body, "personal", () => {}, { activity: true });
    } else if (mode === "works") library.show(body);
    else composer?.update();
    if (view === "activity" && requested !== view) {
      const activity = body.querySelector<HTMLElement>("[data-creation-entry-activity]");
      activity?.scrollIntoView({ block: "start" });
      if (activity) {
        activity.tabIndex = -1;
        activity.focus({ preventScroll: true });
      }
    }
    requested = view;
  }
  return { show, hide };
}
