import type { Translate } from "../../shared/i18n/messages.js";
import {
  defaultSkillWorkspace,
  skillPinId,
  type SkillWorkspaceCommand,
  type SkillPinInput,
} from "../../shared/skill-workspace.js";
import { setMessageHtml } from "../i18n.js";
import type { SkillWorkspaceClient } from "./client.js";
import { workspaceDialogView, type WorkspaceDialogMode } from "./dialog-views.js";
import { showWorkspaceNotice } from "./notice.js";
import { isSupportedLocale } from "../../shared/i18n/locale-policy.js";

export function createSkillWorkspaceDialogs(
  t: Translate,
  client: SkillWorkspaceClient,
  options: { selected(): string; navigate(id: string): void; openSkill(key: string): void },
) {
  const dialog = document.createElement("dialog");
  dialog.id = "skillWorkspaceDialog";
  dialog.className = "workbench-dialog skills-config-dialog";
  dialog.setAttribute("aria-labelledby", "skillWorkspaceDialogTitle");
  document.body.append(dialog);
  let mode: WorkspaceDialogMode | null = null,
    previous: Element | null = null,
    afterEdit: WorkspaceDialogMode | null = null,
    renderedRevision = -1;
  const snapshot = () => client.snapshot || defaultSkillWorkspace();
  function controls() {
    if (!dialog.open) return;
    dialog.setAttribute("aria-busy", String(client.busy));
    for (const el of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")) {
      const allowed =
        el.dataset.skillsAction === "close" ||
        el.dataset.skillsAction === "retry" ||
        el.dataset.skillsAction === "categories";
      el.disabled = !allowed && (!client.snapshot || client.busy || Boolean(client.pending));
      if (el instanceof HTMLButtonElement && el.dataset.skillsMove) {
        const index = Number(el.dataset.skillsMove) + Number(el.dataset.direction);
        el.disabled ||= index < 0 || index >= snapshot().pins.length;
      }
    }
    showWorkspaceNotice(dialog.querySelector<HTMLElement>("[data-skills-dialog-notice]")!, client, t);
  }
  function render() {
    if (!mode) return;
    const scroll = dialog.querySelector<HTMLElement>(".skills-dialog-body")?.scrollTop || 0;
    const active = document.activeElement,
      focus = active instanceof HTMLElement && dialog.contains(active) ? active.dataset.skillsPinCategory : null;
    setMessageHtml(dialog, workspaceDialogView(t, mode, snapshot(), options.selected()));
    renderedRevision = snapshot().revision;
    dialog.querySelector<HTMLElement>(".skills-dialog-body")!.scrollTop = scroll;
    controls();
    if (focus) dialog.querySelector<HTMLInputElement>(`[data-skills-pin-category="${focus}"]`)?.focus();
  }
  function close() {
    mode = null;
    afterEdit = null;
    dialog.close();
    dialog.replaceChildren();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    else if (previous instanceof HTMLElement && previous.dataset.skillsAction)
      [
        ...document.querySelectorAll<HTMLElement>(
          `.skills-workspace [data-skills-action="${previous.dataset.skillsAction}"]`,
        ),
      ]
        .find((el) => el.getClientRects().length)
        ?.focus({ preventScroll: true });
    previous = null;
  }
  function open(value: WorkspaceDialogMode) {
    if (!dialog.open) previous = document.activeElement;
    mode = value;
    render();
    if (!dialog.open) dialog.showModal();
    controls();
  }
  async function save(command: SkillWorkspaceCommand, done?: () => void) {
    try {
      await client.change(command);
      done?.();
    } catch {
      controls();
    }
  }
  client.subscribe(() => {
    if (!mode) return;
    if (snapshot().revision !== renderedRevision) render();
    else controls();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.oninput = (event) => {
    const target = event.target;
    if (mode?.kind === "edit" && target instanceof HTMLInputElement) {
      const locale = target.dataset.skillCategoryLocale;
      if (isSupportedLocale(locale)) mode.name[locale] = target.value;
    }
  };
  dialog.onchange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (mode?.kind === "assign" && target.dataset.skillsAssignment) {
      const id = target.dataset.skillsAssignment;
      mode.selected = target.checked ? [...mode.selected, id] : mode.selected.filter((value) => value !== id);
    }
    if (target.dataset.skillsPinCategory) {
      const id = target.dataset.skillsPinCategory,
        pins: SkillPinInput[] = snapshot().pins.filter((pin) => pin.kind !== "category" || pin.id !== id);
      if (target.checked) pins.push({ kind: "category", id });
      void save({ type: "pins", pins });
    }
  };
  dialog.onsubmit = (event) => {
    event.preventDefault();
    if (mode?.kind !== "edit" || client.busy || client.pending) return;
    const value = mode,
      names = Object.fromEntries(Object.entries(value.name).map(([locale, text]) => [locale, text?.trim() || ""])),
      fallback = names.en || names["zh-CN"] || names["zh-HK"] || names["zh-TW"] || "";
    if (!fallback) {
      dialog.querySelector<HTMLInputElement>('input[name="zh"]')?.focus();
      return;
    }
    void save(
      {
        type: value.id ? "rename-category" : "create-category",
        id: value.id || "custom-" + crypto.randomUUID(),
        name: {
          en: names.en || fallback,
          "zh-CN": names["zh-CN"] || fallback,
          "zh-HK": names["zh-HK"] || "",
          "zh-TW": names["zh-TW"] || "",
        },
      },
      () => {
        mode = afterEdit || { kind: "categories" };
        afterEdit = null;
        render();
      },
    );
  };
  dialog.onclick = (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!button || button.disabled) return;
    if (button.dataset.skillsCategory) {
      close();
      options.navigate(button.dataset.skillsCategory);
      return;
    }
    if (button.dataset.skillsKey) {
      const key = button.dataset.skillsKey;
      close();
      options.openSkill(key);
      return;
    }
    const action = button.dataset.skillsAction;
    if (action === "save-category") {
      dialog.querySelector<HTMLFormElement>("form")?.requestSubmit();
      return;
    }
    if (action === "close") {
      close();
      return;
    }
    if (action === "pins" || action === "categories") {
      mode = { kind: action };
      render();
      return;
    }
    if (action === "retry") {
      const command = client.pending?.command;
      void client
        .retry()
        .then(() => {
          if (!mode) return;
          if (command?.type === "assign") close();
          else if (["create-category", "rename-category", "delete-category"].includes(command?.type || "")) {
            mode = afterEdit || { kind: "categories" };
            afterEdit = null;
            render();
          }
        })
        .catch(() => controls());
      return;
    }
    if (action === "new-category") {
      afterEdit = mode?.kind === "assign" ? mode : null;
      mode = { kind: "edit", name: { en: "", "zh-CN": "" } };
      render();
      dialog.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (button.dataset.skillsEditCategory) {
      const category = snapshot().categories.find((c) => c.id === button.dataset.skillsEditCategory);
      if (category) {
        mode = { kind: "edit", id: category.id, name: { ...category.name } };
        render();
      }
      return;
    }
    if (button.dataset.skillsDeleteCategory) {
      mode = { kind: "delete", id: button.dataset.skillsDeleteCategory };
      render();
      return;
    }
    if (action === "confirm-delete" && mode?.kind === "delete") {
      void save({ type: "delete-category", id: mode.id }, () => {
        mode = { kind: "categories" };
        render();
      });
      return;
    }
    if (action === "restore") {
      void save({ type: "reset-pins" });
      return;
    }
    if (action === "save-assignment" && mode?.kind === "assign") {
      void save({ type: "assign", key: mode.item.key, categoryIds: mode.selected, replaceDefaults: true }, close);
      return;
    }
    if (button.dataset.skillsUnpin) {
      void save({
        type: "pins",
        pins: snapshot().pins.filter((pin) => skillPinId(pin) !== button.dataset.skillsUnpin),
      });
      return;
    }
    if (button.dataset.skillsMove) {
      const index = Number(button.dataset.skillsMove),
        next = index + Number(button.dataset.direction),
        pins = [...snapshot().pins];
      if (next < 0 || next >= pins.length) return;
      [pins[index], pins[next]] = [pins[next]!, pins[index]!];
      void save({ type: "pins", pins }, () =>
        dialog
          .querySelector<HTMLElement>(`[data-skills-move="${next}"][data-direction="${button.dataset.direction}"]`)
          ?.focus(),
      );
    }
  };
  return { open, close };
}
