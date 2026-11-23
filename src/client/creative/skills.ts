import type { Translate } from "../../shared/i18n/messages.js";
import { builtinSkillCategories, skillPinId, type SkillPinInput } from "../../shared/skill-workspace.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import type { createLazyTemplateManager } from "../templates/lazy-settings.js";
import { getBrowserI18n, setMessageHtml } from "../i18n.js";
import { SkillWorkspaceClient } from "../skill-workspace/client.js";
import { createSkillWorkspaceDialogs } from "../skill-workspace/dialogs.js";
import { assignmentFor } from "../skill-workspace/dialog-views.js";
import { workspaceFrame, filters, navigation, categoryName } from "../skill-workspace/views.js";
import { showWorkspaceNotice } from "../skill-workspace/notice.js";

/** Personal categories and shortcuts organize the existing catalog without changing its native authority. */
export function createSkillsWorkspace(
  t: Translate,
  navigate: (path: string) => void,
  manager: ReturnType<typeof createLazyTemplateManager>,
) {
  const client = new SkillWorkspaceClient();
  let host: HTMLElement | null = null,
    mounted = "",
    selected = "all",
    engine = "",
    initialized = false,
    assignmentStamp = "";
  const categories = () => client.snapshot?.categories || builtinSkillCategories;
  const title = () =>
    selected === "all"
      ? t("skillWorkspace.all")
      : categories().find((c) => c.id === selected)
        ? categoryName(categories().find((c) => c.id === selected)!)
        : t("skillWorkspace.categoryMissing");
  const select = (id: string) => navigate(id === "all" ? "/skills" : "/skills/" + encodeURIComponent(id));
  const dialogs = createSkillWorkspaceDialogs(t, client, {
    selected: () => selected,
    navigate: select,
    openSkill: (key) => void manager.openItem(key),
  });
  async function togglePin(item: ManagedTemplate) {
    if (!client.snapshot) return;
    const id = skillPinId({ kind: "skill", key: item.key }),
      pins: SkillPinInput[] = client.snapshot.pins.filter((pin) => skillPinId(pin) !== id);
    if (pins.length === client.snapshot.pins.length) pins.push({ kind: "skill", key: item.key });
    await client.change({ type: "pins", pins });
  }
  const actions = {
    ready: () => Boolean(client.snapshot && !client.busy && !client.pending),
    isPinned: (key: string) => Boolean(client.snapshot?.pins.some((pin) => pin.kind === "skill" && pin.key === key)),
    togglePin,
    assign: (item: ManagedTemplate) => {
      if (client.snapshot) dialogs.open({ kind: "assign", item, selected: [...assignmentFor(client.snapshot, item)] });
    },
  };
  function sync() {
    if (!host) return;
    if (selected !== "all" && client.snapshot && !categories().some((c) => c.id === selected)) {
      select("all");
      return;
    }
    const nav = host.querySelector<HTMLElement>("[data-skills-navigation]")!;
    const focused =
      document.activeElement instanceof HTMLElement && nav.contains(document.activeElement)
        ? document.activeElement.dataset.skillsCategory
        : null;
    setMessageHtml(nav, navigation(t, client.snapshot, selected));
    if (focused) nav.querySelector<HTMLElement>(`[data-skills-category="${focused}"]`)?.focus({ preventScroll: true });
    const tools = host.querySelector<HTMLElement>("[data-template-workspace-tools]");
    if (tools) {
      const keepFocus = tools.contains(document.activeElement);
      setMessageHtml(tools, filters(t, client.snapshot, selected));
      if (keepFocus) tools.querySelector("select")?.focus({ preventScroll: true });
    }
    showWorkspaceNotice(host.querySelector<HTMLElement>("[data-skills-notice]")!, client, t);
    const heading = host.querySelector<HTMLElement>("[data-skills-gallery] h1");
    if (heading) heading.textContent = title();
    manager.syncWorkspace();
    const stamp = String(client.snapshot?.revision ?? "");
    if (selected !== "all" && assignmentStamp && assignmentStamp !== stamp) void manager.reload();
    assignmentStamp = stamp;
  }
  client.subscribe(sync);
  getBrowserI18n().subscribe(() => {
    if (host) sync();
  });
  return {
    show(target: HTMLElement, category = "all", chosenEngine = "") {
      const key = category + ":" + chosenEngine;
      if (host === target && mounted === key) return;
      manager.hide();
      host = target;
      mounted = key;
      selected = category || "all";
      engine = chosenEngine;
      setMessageHtml(target, workspaceFrame(t, selected, client.snapshot));
      manager.setWorkspaceActions(actions);
      const cat = categories().find((c) => c.id === selected);
      manager.show(target.querySelector<HTMLElement>("[data-skills-gallery]")!, {
        domain: "skills",
        ...(cat?.section ? { section: cat.section } : {}),
        ...(selected !== "all" ? { collection: selected } : {}),
        ...(engine ? { engine } : {}),
        title: title(),
        all: selected === "all",
      });
      target.onclick = (event) => {
        const button = (event.target as Element).closest<HTMLElement>(
          "[data-skills-category],[data-skills-key],[data-skills-action]",
        );
        if (!button) return;
        if (button instanceof HTMLButtonElement && button.disabled) return;
        if (button.dataset.skillsCategory) {
          select(button.dataset.skillsCategory);
          return;
        }
        if (button.dataset.skillsKey) {
          void manager.openItem(button.dataset.skillsKey);
          return;
        }
        const action = button.dataset.skillsAction;
        if (action === "pins" || action === "categories" || action === "navigation") {
          const menu = button.closest("[data-template-menu]");
          menu?.removeAttribute("open");
          menu?.querySelector("summary")?.focus();
          dialogs.open({ kind: action });
        }
        if (action === "retry") void client.retry().catch(() => {});
      };
      target.onchange = (event) => {
        const el = event.target;
        if (el instanceof HTMLSelectElement && el.hasAttribute("data-skills-select")) select(el.value);
      };
      sync();
      if (!initialized || !client.snapshot) {
        initialized = true;
        void client.load();
      }
    },
    hide() {
      if (host) {
        host.onclick = null;
        host.onchange = null;
      }
      dialogs.close();
      manager.hide();
      manager.setWorkspaceActions(null);
      host = null;
      mounted = "";
    },
  };
}
