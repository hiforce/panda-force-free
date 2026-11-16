import type { ProjectionCapability } from "./bindings.js";
import type { GadgetComponent, GadgetContext } from "../../client/gadget/contracts.js";
import type { GadgetRow } from "./ports.js";
import { presentationLabel } from "../../client/presentation-labels.js";
import { gt } from "../../client/gadget/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../../client/i18n.js";
import { codexIcon } from "../../client/codex-icons.js";
import { managedCover } from "../../client/templates/covers.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import type { MessageId } from "../../shared/i18n/messages.js";
export function rowGadget(options: {
  projection?: string;
  filter?: (row: GadgetRow) => boolean;
  skills?: boolean;
  tabs?: boolean;
  icon: string;
  empty?: "noRecent" | "noAttention" | "noProjects" | "noSkills";
}): GadgetComponent {
  return {
    mount(root, initial) {
      let context = initial,
        epoch = 0,
        filter = "all";
      async function update(next: GadgetContext) {
        context = next;
        const ticket = ++epoch;
        let rows: GadgetRow[];
        if (options.projection && !next.capability<ProjectionCapability>(options.projection).ready()) {
          setMessageHtml(root, `<p class="gadget-empty" role="status">${e(gt(next.t, "loading"))}</p>`);
          return;
        }
        rows = (await next.data("summary")) as GadgetRow[];
        if (next.signal.aborted || ticket !== epoch) return;
        const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset : null;
        rows = rows
          .filter((r) => (!options.filter || options.filter(r)) && (filter === "all" || r.status === filter))
          .slice(0, Number(next.instance.config.limit) || 5);
        setMessageHtml(
          root,
          `${
            options.tabs
              ? `<div class="gadget-tabs" role="tablist">${[
                  ["all", "recent"],
                  ["running", "running"],
                  ["done", "finished"],
                ]
                  .map(
                    ([v, k]) =>
                      `<button type="button" role="tab" aria-selected="${filter === v}" data-filter="${v}" class="${filter === v ? "active" : ""}">${e(gt(next.t, k as "recent"))}</button>`,
                  )
                  .join("")}</div>`
              : ""
          }<div class="${options.skills ? "gadget-skill-grid" : "gadget-rows"}">${
            rows.length
              ? rows
                  .map((row) => {
                    const template = (row as GadgetRow & { template?: ManagedTemplate }).template,
                      titleId = (row as GadgetRow & { titleId?: MessageId }).titleId,
                      title = template
                        ? presentationLabel(next.t, template.label)
                        : titleId
                          ? next.t(titleId)
                          : row.title || next.t("workbench.untitledSession");
                    return `<button type="button" class="${options.skills ? "gadget-skill" : "gadget-row"}" data-id="${e(row.id)}">${options.skills && template ? managedCover(template) : `<span class="gadget-row-icon">${codexIcon(options.icon)}</span>`}<span class="gadget-row-copy"><strong data-i18n-ignore>${e(title)}</strong><small data-i18n-ignore>${e(options.skills ? "v" + row.version : row.description || "")}</small></span>${row.status ? `<span class="gadget-status ${e(row.status)}"><i></i>${e(row.status === "review" ? gt(next.t, "needsReview") : row.status === "running" ? gt(next.t, "running") : row.status === "done" ? gt(next.t, "finished") : next.t("common.ready"))}</span>` : options.skills ? "" : codexIcon("chevronRight")}</button>`;
                  })
                  .join("")
              : `<p class="gadget-empty">${e(gt(next.t, options.empty ?? "noRecent"))}</p>`
          }</div>`,
        );
        if (focused?.id)
          root.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused.id)}"]`)?.focus({ preventScroll: true });
        else if (focused?.filter)
          root
            .querySelector<HTMLElement>(`[data-filter="${CSS.escape(focused.filter)}"]`)
            ?.focus({ preventScroll: true });
      }
      root.onclick = (event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
        if (!target) return;
        if (target.dataset.filter) {
          filter = target.dataset.filter;
          void update(context).catch(() => {});
        } else if (target.dataset.id) {
          const id = target.dataset.id;
          void (async () => {
            if (options.skills) {
              const rows = (await context.data("summary")) as Array<GadgetRow & { template?: ManagedTemplate }>;
              const selected = rows.find((r) => r.id === id)?.template;
              if (selected && context.events.publish("creation.skill-selected", selected)) return;
            }
            await context.action("open", { id });
          })().catch(() => {});
        }
      };
      return {
        update,
        dispose() {
          epoch++;
          root.onclick = null;
        },
      };
    },
  };
}
