import { syncComposerPanelViewport } from "./session-controls/menu.js";
import { codexIcon } from "./codex-icons.js";
import { localizeAttribute, localizeText, setMessageHtml } from "./i18n.js";
import type { Translate } from "../shared/i18n/messages.js";

/** Bounded context rails reuse their actual cards and upload controls, including inside the file manager. */
export function createComposerContexts(form: HTMLFormElement, body: HTMLElement, t: Translate) {
  const group = document.createElement("div");
  group.className = "message-composer-contexts";
  const sections: { host: HTMLElement; frame: HTMLElement; manage: HTMLButtonElement; kind: "files" | "skills" }[] = [];
  const dialog = document.createElement("dialog"),
    heading = document.createElement("header"),
    title = document.createElement("h2"),
    close = document.createElement("button"),
    list = document.createElement("div");
  dialog.className = "session-dialog message-composer-context-dialog composer-panel";
  title.id = "composer-files-" + crypto.randomUUID();
  dialog.setAttribute("aria-labelledby", title.id);
  heading.className = "composer-panel-heading";
  close.type = "button";
  close.className = "composer-panel-action";
  setMessageHtml(close, codexIcon("x"));
  heading.append(title, close);
  list.className = "message-composer-context-list";
  dialog.append(heading, list);
  let anchor: Comment | null = null,
    returnedTo: HTMLElement | null = null;
  const returnFiles = () => {
    if (dialog.open) dialog.close();
    const host = sections.find((section) => section.kind === "files")?.host;
    if (host && anchor?.parentNode) anchor.before(host);
    anchor?.remove();
    anchor = null;
    if (returnedTo?.getClientRects().length) returnedTo.focus({ preventScroll: true });
    else if (returnedTo)
      form.querySelector<HTMLElement>('[data-composer-control="add"]')?.focus({ preventScroll: true });
    returnedTo = null;
  };
  close.onclick = returnFiles;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    returnFiles();
  });
  for (const [selector, kind] of [
    [".composer-attachments", "files"],
    [".creative-selected-skills", "skills"],
  ] as const) {
    const host = body.querySelector<HTMLElement>(selector);
    if (!host) continue;
    const frame = document.createElement("div"),
      manage = document.createElement("button");
    frame.className = "message-composer-tray";
    frame.dataset.composerContext = kind;
    manage.type = "button";
    manage.className = "message-composer-tray-manage";
    manage.setAttribute("aria-haspopup", "dialog");
    manage.dataset.manageComposerContext = kind;
    if (!group.parentNode) host.before(group);
    frame.append(host, manage);
    group.append(frame);
    sections.push({ host, frame, manage, kind });
    manage.onclick = () => {
      if (kind === "skills") {
        const trigger = form.querySelector<HTMLButtonElement>("[data-composer-skill-trigger]");
        if (trigger) trigger.click();
        else form.dispatchEvent(new Event("composer:browse-skills"));
      } else {
        if (!dialog.isConnected) document.body.append(dialog);
        anchor = document.createComment("Attachment controls return here");
        host.before(anchor);
        list.append(host);
        returnedTo = manage;
        dialog.showModal();
        syncComposerPanelViewport(dialog);
        close.focus({ preventScroll: true });
      }
    };
  }
  const count = (kind: "files" | "skills") => {
    const host = sections.find((section) => section.kind === kind)?.host;
    return host?.querySelectorAll(kind === "files" ? ".composer-attachment" : "[data-selected-skill]").length || 0;
  };
  function refresh() {
    if (dialog.open) syncComposerPanelViewport(dialog);
    const files = count("files"),
      skills = count("skills");
    const short = (window.visualViewport?.height || innerHeight) < 520;
    const dense = short || (innerWidth < 768 && (files > 2 || skills > 2 || (innerWidth < 360 && files + skills > 1)));
    group.classList.toggle("composer-contexts-summary", dense);
    group.classList.toggle("has-single-skill", skills === 1);
    form.classList.toggle("composer-short-viewport", short);
    for (const section of sections) {
      const total = count(section.kind),
        hidden = total === 0;
      if (section.frame.hidden !== hidden) section.frame.hidden = hidden;
      section.frame.classList.toggle("message-composer-tray-single-skill", section.kind === "skills" && total === 1);
      const hideManage = section.kind === "skills" && total <= 1;
      if (section.manage.hidden !== hideManage) section.manage.hidden = hideManage;
      const label = section.kind === "files" ? "composer.manageFilesCount" : "composer.manageSkillsCount";
      if (section.manage.textContent !== t(label, { count: total }))
        localizeText(section.manage, label, { count: total }, t);
    }
    const hidden = sections.every((section) => section.frame.hidden);
    if (group.hidden !== hidden) group.hidden = hidden;
    localizeText(title, "common.attachments", undefined, t);
    localizeAttribute(close, "aria-label", "common.close", undefined, t);
    if (dialog.open && count("files") === 0) returnFiles();
  }
  const observer = new MutationObserver(refresh);
  for (const section of sections)
    observer.observe(section.host, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  refresh();
  window.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("resize", refresh);
  return {
    refresh,
    count,
    close: returnFiles,
    dispose() {
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
      returnFiles();
      dialog.remove();
    },
  };
}
