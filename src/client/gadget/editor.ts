import { captureRenderFocus, restoreRenderFocus } from "../render-focus.js";
import type { GadgetInstance, GadgetLayout, GadgetManifest } from "../../shared/gadget/contracts.js";
import { collides, settleGadgetLayout, validateGadgetConfig } from "../../shared/gadget/layout.js";
import { gadgetName } from "../../shared/gadget/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { gt } from "./messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { gadgetIcon as codexIcon } from "./icons.js";
import { setMessageHtml } from "../i18n.js";
export interface GadgetEditorHost {
  t: Translate;
  locale(): string;
  catalog(): GadgetManifest[];
  layout(): GadgetLayout;
  change(run: (layout: GadgetLayout) => void, preserveControl?: boolean): void;
  selected: string | null;
  render(): void;
  notice(text: string): void;
  confirmRestore(): void;
}
export class GadgetEditor {
  panel: "library" | "layout" | "config" = "library";
  filter = "all";
  search = "";
  open = false;
  readonly dialog = document.createElement("dialog");
  constructor(private host: GadgetEditorHost) {
    this.dialog.className = "gadget-editor-dialog";
    document.body.append(this.dialog);
    this.dialog.addEventListener("close", () => {
      this.open = false;
    });
    this.dialog.addEventListener("cancel", () => {
      this.open = false;
    });
    this.dialog.addEventListener("click", (event) => this.click(event));
    this.dialog.addEventListener("input", (event) => this.input(event));
    this.dialog.addEventListener("change", (event) => this.changed(event));
  }
  private name(m: GadgetManifest) {
    return gadgetName(m.title, this.host.locale());
  }
  private item() {
    return this.host.layout().items.find((i) => i.id === this.host.selected);
  }
  show(panel: GadgetEditor["panel"]) {
    this.panel = panel;
    this.open = true;
    this.host.render();
    if (innerWidth < 1050 && !this.dialog.open) this.dialog.showModal();
  }
  close() {
    this.open = false;
    this.dialog.close();
  }
  render(container: HTMLElement) {
    const focus = captureRenderFocus(this.dialog) ?? captureRenderFocus(container);
    const panel = `<aside class="gadget-panel"><header class="gadget-panel-head">${this.panel === "config" ? `<button class="icon-button" data-ge="library" aria-label="${gt(this.host.t, "back")}">${codexIcon("chevronLeft")}</button><strong>${gt(this.host.t, "widgetSettings")}</strong>` : `<button class="${this.panel === "library" ? "active" : ""}" data-ge="library">${gt(this.host.t, "library")}</button><button class="${this.panel === "layout" ? "active" : ""}" data-ge="layout">${gt(this.host.t, "layoutSettings")}</button>`}<button class="icon-button gadget-panel-close" data-ge="close" aria-label="${gt(this.host.t, "close")}">${codexIcon("x")}</button></header><div class="gadget-panel-scroll">${this.panel === "library" ? this.library() : this.panel === "layout" ? this.settings() : this.config()}</div></aside>`;
    const target = innerWidth < 1050 ? this.dialog : container;
    if (innerWidth < 1050) container.replaceChildren();
    else if (this.dialog.open) this.dialog.close();
    if (!this.open) {
      container.replaceChildren();
      if (this.dialog.open) this.dialog.close();
      return;
    }
    const scroll = target.querySelector(".gadget-panel-scroll")?.scrollTop ?? 0;
    setMessageHtml(target, panel);
    const area = target.querySelector(".gadget-panel-scroll");
    if (area) area.scrollTop = scroll;
    restoreRenderFocus(target, focus);
  }
  private library() {
    const h = this.host;
    return `<div class="gadget-library-search"><p>${gt(h.t, "libraryHint")}</p><label class="wb-field"><span class="sr-only">${gt(h.t, "searchWidgets")}</span><input id="gadgetSearch" type="search" data-ge-search value="${e(this.search)}" placeholder="${gt(h.t, "searchWidgets")}"></label><div class="gadget-tabs">${["all", "system", "extension"].map((v) => `<button data-ge="filter" data-value="${v}" class="${this.filter === v ? "active" : ""}">${gt(h.t, v === "system" ? "builtin" : v === "extension" ? "custom" : "all")}</button>`).join("")}</div></div><div class="gadget-library">${h
      .catalog()
      .filter(
        (m) =>
          (this.filter === "all" || this.filter === m.source) &&
          `${this.name(m)} ${gadgetName(m.description, h.locale())} ${m.id}`
            .toLowerCase()
            .includes(this.search.toLowerCase()),
      )
      .map((m) => {
        const added = m.singleton && h.layout().items.some((i) => i.gadget === m.id);
        return `<article class="gadget-library-card" draggable="true" data-gadget-type="${e(m.id)}"><div><span class="gadget-library-icon">${codexIcon(m.icon)}</span><strong>${e(this.name(m))}</strong><small>${gt(h.t, m.source === "system" ? "builtin" : "custom")}</small></div><p>${e(gadgetName(m.description, h.locale()))}</p><footer><small>v${e(m.version)}</small><button type="button" class="wb-button ${added ? "" : "primary"}" data-ge="add" data-type="${e(m.id)}">${codexIcon(added ? "check" : "plus")}${gt(h.t, added ? "added" : "add")}</button></footer></article>`;
      })
      .join("")}</div>`;
  }
  private settings() {
    const h = this.host,
      l = h.layout();
    return `<div class="gadget-setting wb-form"><label class="wb-field"><span>${gt(h.t, "layoutMode")}</span><div class="gadget-presets">${[
      ["primary", "primaryColumns"],
      ["equal", "equalColumns"],
      ["full", "fullColumns"],
    ]
      .map(
        ([v, k]) =>
          `<button type="button" data-ge="preset" data-value="${v}" class="${l.preset === v ? "active" : ""}"><span class="gadget-layout-glyph ${v}"><i></i>${v === "full" ? "" : "<i></i>"}</span>${gt(h.t, k as "primaryColumns")}</button>`,
      )
      .join(
        "",
      )}</div><small>${gt(h.t, "presetHint")}</small></label><label class="wb-field"><span>${gt(h.t, "density")}</span><select data-ge-config="density">${["compact", "comfortable"].map((v) => `<option value="${v}" ${l.density === v ? "selected" : ""}>${gt(h.t, v as "compact")}</option>`).join("")}</select></label><div><strong>${gt(h.t, "mobileOrder")}</strong><p>${gt(h.t, "mobileOrderHint")}</p>${l.mobileOrder
      .map((id, n) => {
        const i = l.items.find((x) => x.id === id)!,
          m = h.catalog().find((x) => x.id === i.gadget);
        return `<div class="gadget-order"><span>${e(i.title || (m && this.name(m)) || i.gadget)}</span><button class="icon-button" data-ge="up" data-id="${id}" ${n === 0 ? "disabled" : ""} aria-label="${gt(h.t, "moveUp")}">${codexIcon("chevronUp")}</button><button class="icon-button" data-ge="down" data-id="${id}" ${n === l.items.length - 1 ? "disabled" : ""} aria-label="${gt(h.t, "moveDown")}">${codexIcon("chevronDown")}</button></div>`;
      })
      .join(
        "",
      )}</div><button class="wb-button" data-ge="restore">${gt(h.t, "restore")}</button><p>${gt(h.t, "restoreHint")}</p></div>`;
  }
  private config() {
    const h = this.host,
      i = this.item();
    if (!i) return "";
    const m = h.catalog().find((m) => m.id === i.gadget);
    return `<div class="gadget-setting wb-form"><small>${e(i.gadget)} · v${e(m?.version ?? "")}</small><label class="wb-field"><span>${gt(h.t, "widgetTitle")}</span><input id="gadgetTitle" data-ge-config="title" value="${e(i.title)}" maxlength="80" placeholder="${e(m ? this.name(m) : i.gadget)}"></label><label class="wb-field"><span>${gt(h.t, "width")}</span><select data-ge-config="w">${[
      4, 6, 8, 12,
    ]
      .filter((w) => w >= (m?.layout.minW ?? 1))
      .map(
        (w) =>
          `<option value="${w}" ${i.w === w ? "selected" : ""}>${gt(h.t, ({ 4: "sizeSmall", 6: "sizeMedium", 8: "sizeLarge", 12: "sizeFull" } as const)[w as 4])}</option>`,
      )
      .join("")}</select></label>${Object.entries(m?.config ?? {})
      .map(
        ([key, f]) =>
          `<label class="wb-field"><span>${e(f.label ? gadgetName(f.label, h.locale()) : key)}</span><input id="gadgetConfig-${e(key)}" data-ge-field="${e(key)}" type="${f.type === "number" ? "number" : f.type === "boolean" ? "checkbox" : "text"}" ${f.type === "boolean" ? (i.config[key] ? "checked" : "") : `value="${e(i.config[key])}"`} ${f.type === "number" ? `min="${f.min ?? 0}" max="${f.max ?? 20}" step="1"` : `maxlength="${f.max ?? 200}"`}></label>`,
      )
      .join(
        "",
      )}<fieldset><legend>${gt(h.t, "visibility")}</legend>${["desktop", "mobile"].map((d) => `<label class="gadget-check"><input type="checkbox" data-ge-visible="${d}" ${i.visible[d as "desktop"] ? "checked" : ""}>${gt(h.t, d === "desktop" ? "pc" : "mobile")}</label>`).join("")}</fieldset><button class="wb-button" data-ge="remove" data-id="${i.id}">${gt(h.t, "remove")}</button></div>`;
  }
  click(event: Event) {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ge]") : null;
    if (!el) return;
    const type = el.dataset.ge,
      id = el.dataset.id,
      h = this.host;
    if (type === "close") {
      this.close();
      return;
    }
    if (type === "library" || type === "layout") {
      this.show(type);
      return;
    }
    if (type === "filter") {
      this.filter = el.dataset.value!;
      h.render();
      return;
    }
    if (type === "add") {
      this.add(el.dataset.type!);
      return;
    }
    if (type === "preset") {
      this.preset(el.dataset.value as GadgetLayout["preset"]);
      return;
    }
    if (type === "up" || type === "down") {
      this.order(id!, type === "up" ? -1 : 1);
      return;
    }
    if (type === "remove") {
      this.remove(id!);
      return;
    }
    if (type === "restore") h.confirmRestore();
  }
  input(event: Event) {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.dataset.geConfig === "title") {
      const item = this.item();
      if (item) this.host.change(() => (item.title = el.value), true);
      return;
    }
    if (el.hasAttribute("data-ge-search")) {
      this.search = el.value;
      this.host.render();
    }
  }
  changed(event: Event) {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
    const h = this.host;
    if (el.dataset.geConfig === "density") {
      h.change((l) => (l.density = el.value as GadgetLayout["density"]));
      return;
    }
    const item = this.item();
    if (!item) return;
    if (el.dataset.geVisible) {
      h.change(() => (item.visible[el.dataset.geVisible as "desktop"] = (el as HTMLInputElement).checked));
      return;
    }
    if (el.dataset.geConfig === "title") {
      h.change(() => (item.title = el.value));
      return;
    }
    if (el.dataset.geConfig === "w") {
      h.change((l) => {
        item.w = Number(el.value);
        settleGadgetLayout(l.items, item);
      });
      return;
    }
    if (el.dataset.geField) {
      const m = h.catalog().find((m) => m.id === item.gadget)!;
      try {
        const field = el.dataset.geField,
          definition = m.config[field]!,
          next = {
            ...item.config,
            [field]:
              definition.type === "number"
                ? Number(el.value)
                : definition.type === "boolean"
                  ? (el as HTMLInputElement).checked
                  : el.value,
          };
        const valid = validateGadgetConfig(next, m);
        h.change(() => (item.config = valid));
      } catch {
        h.notice(gt(h.t, "invalidInput"));
      }
    }
  }
  add(type: string, x?: number, y?: number) {
    const h = this.host,
      m = h.catalog().find((m) => m.id === type);
    if (!m) return;
    const existing = h.layout().items.find((i) => i.gadget === m.id);
    if (existing && m.singleton) {
      h.selected = existing.id;
      this.show("config");
      h.notice(gt(h.t, "alreadyToast"));
      return;
    }
    if (h.layout().items.length >= 24) {
      h.notice(gt(h.t, "invalidInput"));
      return;
    }
    h.change((l) => {
      const i: GadgetInstance = {
        id: crypto.randomUUID(),
        gadget: m.id,
        title: "",
        configVersion: m.configVersion,
        config: validateGadgetConfig({}, m),
        x: x ?? 0,
        y: y ?? Math.max(0, ...l.items.map((i) => i.y + i.h)),
        w: m.layout.w,
        h: m.layout.h,
        visible: { desktop: true, mobile: true },
      };
      l.items.push(i);
      l.mobileOrder.push(i.id);
      settleGadgetLayout(l.items, i);
      h.selected = i.id;
    });
    if (innerWidth < 1050) this.close();
    h.notice(gt(h.t, "addedToast"));
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-gadget-instance="${h.selected}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }
  remove(id: string) {
    this.host.change((l) => {
      l.items = l.items.filter((i) => i.id !== id);
      l.mobileOrder = l.mobileOrder.filter((i) => i !== id);
    });
    this.host.notice(gt(this.host.t, "removedToast"));
  }
  order(id: string, offset: number) {
    this.host.change((l) => {
      const a = l.mobileOrder,
        n = a.indexOf(id),
        b = Math.max(0, Math.min(a.length - 1, n + offset));
      [a[n], a[b]] = [a[b]!, a[n]!];
    });
  }
  preset(preset: GadgetLayout["preset"]) {
    this.host.change((l) => {
      l.preset = preset;
      const placed: GadgetInstance[] = [];
      for (const i of l.items.toSorted((a, b) => a.y - b.y || a.x - b.x)) {
        const m = this.host.catalog().find((m) => m.id === i.gadget);
        i.w = preset === "full" ? 12 : preset === "equal" ? Math.max(6, m?.layout.minW ?? 1) : (m?.layout.w ?? i.w);
        let found = false;
        for (let y = 0; y < 4096 && !found; y++)
          for (let x = 0; x <= 12 - i.w; x++) {
            if (!placed.some((p) => collides({ x, y, w: i.w, h: i.h }, p))) {
              i.x = x;
              i.y = y;
              found = true;
              break;
            }
          }
        placed.push(i);
      }
    });
  }
}
