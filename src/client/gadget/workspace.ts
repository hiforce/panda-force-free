import { GadgetMounts } from "./mounts.js";
import { GadgetEvents } from "./events.js";
import { GadgetClient, GadgetApiError } from "../../gadget/sdk/client.js";
import { ClientGadgetRegistry } from "./contracts.js";
import { GadgetEditor } from "./editor.js";
import { GadgetDataBudget } from "./data.js";
import { bindGadgetMovement } from "./movement.js";
import { defaultGadgetLayout, validateGadgetLayout } from "../../shared/gadget/layout.js";
import {
  gadgetName,
  type GadgetManifest,
  type GadgetLayout,
  type GadgetInstance,
} from "../../shared/gadget/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { request } from "../http-client.js";
import { gadgetIcon as codexIcon } from "./icons.js";
import { gt, type GadgetMessage } from "./messages.js";
import type { Translate } from "../../shared/i18n/messages.js";
export class GadgetWorkspace {
  readonly events = new GadgetEvents();
  readonly api = new GadgetClient("", request as typeof fetch);
  readonly budget = new GadgetDataBudget();
  readonly root = document.createElement("section");
  readonly header = document.createElement("header");
  readonly canvas = document.createElement("div");
  readonly panel = document.createElement("div");
  readonly feedback = document.createElement("p");
  readonly controls = document.createElement("div");
  readonly editor: GadgetEditor;
  private manifests: Array<GadgetManifest & { frontend?: boolean }>;
  private saved: GadgetLayout;
  private draft: GadgetLayout | null = null;
  private history: GadgetLayout[] = [];
  private readonly mounts: GadgetMounts;
  private visible = false;
  private ready = false;
  private error = "";
  private loading = false;
  private editing = false;
  private preview = false;
  private device: "desktop" | "mobile" = "desktop";
  private saving = false;
  private pending: { id: string; layout: GadgetLayout } | null = null;
  private changed = false;
  private noticeMessage = "";
  selected: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadController: AbortController | null = null;
  private confirm = document.createElement("dialog");
  constructor(
    readonly t: Translate,
    readonly locale: () => string,
    readonly registry: ClientGadgetRegistry,
    capabilities: ReadonlyMap<string, unknown>,
    navigate: (path: string) => void,
  ) {
    this.mounts = new GadgetMounts({
      t,
      locale,
      registry,
      api: this.api,
      budget: this.budget,
      events: this.events,
      capabilities,
      navigate,
      notice: (text) => this.notice(text),
      code: (error) => this.code(error),
      failure: (id, item, code, retry) =>
        setMessageHtml(
          item.body,
          `<div class="gadget-error" role="status">${codexIcon(code === "forbidden" ? "lockKeyhole" : "circleAlert")}<p>${e(gt(this.t, code))}</p>${retry ? this.button("retry-widget", "retry", "rotateCw", false, false, `data-id="${id}"`) : ""}</div>`,
        ),
    });
    this.manifests = this.registry.catalog();
    this.saved = defaultGadgetLayout(this.manifests);
    this.root.className = "gadget-workspace";
    this.header.className = "gadget-workspace-heading";
    this.canvas.className = "gadget-canvas";
    this.panel.className = "gadget-editor-slot";
    this.feedback.className = "gadget-feedback";
    this.feedback.setAttribute("role", "status");
    this.controls.className = "gadget-mobile-tools";
    const area = document.createElement("div");
    area.className = "gadget-workspace-area";
    area.append(this.canvas, this.panel);
    this.root.append(this.header, this.feedback, area, this.controls);
    this.editor = new GadgetEditor({
      t,
      locale,
      catalog: () => this.manifests,
      layout: () => this.layout,
      change: (run, preserve) => this.change(run, preserve),
      get selected() {
        return owner.selected;
      },
      set selected(v) {
        owner.selected = v;
      },
      render: () => this.render(),
      notice: (text) => this.notice(text),
      confirmRestore: () => this.confirmAction("restore"),
    });
    const owner = this;
    this.root.addEventListener("click", (event) => this.click(event));
    this.root.addEventListener("input", (event) => this.editor.input(event));
    this.root.addEventListener("change", (event) => this.editor.changed(event));
    this.confirm.className = "workbench-dialog gadget-confirm";
    document.body.append(this.confirm);
    bindGadgetMovement({
      root: this.root,
      editing: () => this.editing && !this.preview && !this.pending,
      mobile: () => this.mobile,
      layout: () => this.layout,
      manifest: (id) => this.manifests.find((m) => m.id === id),
      change: (run) => this.change(run),
      add: (id, x, y) => this.editor.add(id, x, y),
      render: () => this.render(),
    });
    window.addEventListener("resize", () => {
      if (this.visible) this.render();
    });
    window.addEventListener("panda-force:appearance-changed", () => this.refresh());
    document.addEventListener("visibilitychange", () => {
      if (this.visible && !document.hidden) this.refresh();
    });
    window.addEventListener("beforeunload", (event) => {
      if (this.changed || this.pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }
  get layout() {
    return this.draft ?? this.saved;
  }
  get mobile() {
    return innerWidth < 768 || (this.editing && this.device === "mobile");
  }
  show(host: HTMLElement) {
    if (this.root.parentElement !== host) host.replaceChildren(this.root);
    this.visible = true;
    this.render();
    if (!this.ready && !this.loading) void this.load();
    this.schedule();
  }
  hide() {
    this.visible = false;
    this.editor.close();
    this.confirm.close();
    this.loadController?.abort();
    this.loading = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.mounts.clear();
  }
  refresh() {
    if (this.visible) this.render();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.visible && !document.hidden) this.render();
      if (this.visible) this.schedule();
    }, 60000);
  }
  private async load() {
    if (this.loading) return;
    this.loadController?.abort();
    const controller = (this.loadController = new AbortController());
    this.loading = true;
    try {
      const [catalog, layout] = await Promise.all([
        this.api.catalog(controller.signal),
        this.api.layout(controller.signal),
      ]);
      if (controller.signal.aborted || !this.visible) return;
      this.manifests = catalog.gadgets;
      this.saved = layout;
      this.ready = true;
      this.error = "";
    } catch (error) {
      if (!controller.signal.aborted) this.error = this.code(error);
    } finally {
      if (this.loadController === controller) {
        this.loading = false;
        if (this.visible) this.render();
      }
    }
  }
  private code(error: unknown): GadgetMessage {
    return error instanceof GadgetApiError &&
      ["conflict", "forbidden", "missing", "incompatible", "invalidInput"].includes(error.code)
      ? (error.code as GadgetMessage)
      : "unavailable";
  }
  notice(text: string) {
    this.noticeMessage = text;
    this.feedback.textContent = text;
  }
  change(run: (layout: GadgetLayout) => void, preserveControl = false) {
    if (!this.editing || !this.draft || this.pending) return;
    const before = structuredClone(this.draft);
    try {
      run(this.draft);
      if (JSON.stringify(this.draft) === JSON.stringify(before)) return;
      validateGadgetLayout(this.draft, this.manifests, this.saved);
      this.history.push(before);
      if (this.history.length > 30) this.history.shift();
      this.changed = true;
      this.error = "";
    } catch {
      this.draft = before;
      this.notice(gt(this.t, "invalidInput"));
    }
    this.render(preserveControl);
  }
  private start() {
    if (!this.ready) return;
    this.draft ??= structuredClone(this.saved);
    this.editing = true;
    this.preview = false;
    this.device = innerWidth < 768 ? "mobile" : "desktop";
    this.editor.open = innerWidth >= 1050;
    this.render();
  }
  private async save() {
    if (this.saving || !this.draft) return;
    this.pending ??= { id: crypto.randomUUID(), layout: structuredClone(this.draft) };
    this.saving = true;
    this.error = "";
    this.render();
    try {
      const result = await this.api.save(this.pending.layout, this.pending.id);
      this.saved = result;
      this.pending = null;
      this.draft = null;
      this.changed = false;
      this.editing = false;
      this.preview = false;
      this.editor.close();
      this.history = [];
      this.notice(gt(this.t, "saved"));
    } catch (error) {
      this.error = this.code(error);
      if (error instanceof GadgetApiError && error.status < 500) this.pending = null;
    } finally {
      this.saving = false;
      if (this.visible) this.render();
    }
  }
  private async reloadSaved() {
    try {
      const next = await this.api.layout();
      this.saved = next;
      this.draft = null;
      this.pending = null;
      this.changed = false;
      this.editing = false;
      this.preview = false;
      this.editor.close();
      this.error = "";
      this.render();
    } catch (error) {
      this.error = this.code(error);
      this.render();
    }
  }
  private confirmAction(kind: "restore" | "cancel" | "reload") {
    setMessageHtml(
      this.confirm,
      `<header class="wb-page-heading"><h2>${gt(this.t, kind === "restore" ? "restoreTitle" : kind === "reload" ? "loadSaved" : "discardTitle")}</h2></header><p>${gt(this.t, kind === "restore" ? "restoreHint" : "discardBody")}</p><footer><button type="button" class="wb-button" data-confirm-cancel>${gt(this.t, "continueEdit")}</button><button type="button" class="wb-button primary" data-confirm-yes>${gt(this.t, kind === "restore" ? "restore" : kind === "reload" ? "loadSaved" : "discard")}</button></footer>`,
    );
    this.confirm.querySelector<HTMLButtonElement>("[data-confirm-cancel]")!.onclick = () => this.confirm.close();
    this.confirm.querySelector<HTMLButtonElement>("[data-confirm-yes]")!.onclick = () => {
      this.confirm.close();
      if (kind === "restore")
        this.change((l) => Object.assign(l, defaultGadgetLayout(this.manifests), { revision: this.saved.revision }));
      else if (kind === "reload") void this.reloadSaved();
      else {
        this.draft = null;
        this.editing = false;
        this.preview = false;
        this.changed = false;
        this.history = [];
        this.editor.close();
        this.render();
      }
    };
    this.confirm.showModal();
  }
  private click(event: Event) {
    this.editor.click(event);
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-gw]") : null;
    if (!el) return;
    const action = el.dataset.gw,
      id = el.dataset.id;
    if (action === "customize") this.start();
    if (action === "save") void this.save();
    if (action === "cancel" && !this.pending) {
      if (this.changed) this.confirmAction("cancel");
      else {
        this.draft = null;
        this.editing = false;
        this.preview = false;
        this.editor.close();
        this.render();
      }
    }
    if (action === "library") this.editor.show("library");
    if (action === "layout") this.editor.show("layout");
    if (action === "preview") {
      this.preview = !this.preview;
      if (this.preview) this.editor.close();
      this.render();
    }
    if (action === "device") {
      this.device = el.dataset.value as "desktop";
      this.render();
    }
    if (action === "undo" && this.history.length && !this.pending) {
      this.draft = this.history.pop()!;
      this.changed = true;
      this.render();
    }
    if (action === "config") {
      this.selected = id!;
      this.editor.show("config");
    }
    if (action === "remove") this.editor.remove(id!);
    if (action === "up" || action === "down") this.editor.order(id!, action === "up" ? -1 : 1);
    if (action === "retry-load") void this.load();
    if (action === "reload-saved") this.confirmAction("reload");
    if (action === "retry-widget") {
      const instance = this.layout.items.find((item) => item.id === id);
      if (instance) {
        this.budget.invalidate(instance.gadget);
        this.mounts.remove(id!);
        this.render();
      }
    }
  }
  private button(action: string, label: GadgetMessage, icon = "", primary = false, disabled = false, attrs = "") {
    return `<button type="button" class="wb-button ${primary ? "primary" : ""}" data-gw="${action}" aria-label="${e(gt(this.t, label))}" title="${e(gt(this.t, label))}" ${disabled ? "disabled" : ""} ${attrs}>${icon ? codexIcon(icon) : ""}<span>${gt(this.t, label)}</span></button>`;
  }
  render(preserveControls = false) {
    if (!this.visible) return;
    const edit = this.editing && !this.preview;
    this.root.classList.toggle("is-editing", edit);
    this.root.classList.toggle("is-mobile-preview", innerWidth >= 768 && this.editing && this.device === "mobile");
    this.root.classList.toggle("has-panel", edit && this.editor.open && innerWidth >= 1050);
    this.root.style.setProperty("--gadget-gap", this.layout.density === "compact" ? "14px" : "20px");
    setMessageHtml(
      this.header,
      this.editing
        ? `<div><h1>${gt(this.t, "customize")}</h1><small>${gt(this.t, "gridHelp")}</small></div><div class="gadget-heading-actions"><div class="gadget-device">${this.button("device", "pc", "monitor", false, false, 'data-value="desktop"')}${this.button("device", "mobile", "smartphone", false, false, 'data-value="mobile"')}</div>${this.button("library", "addWidget", "plus", false, !!this.pending)}${this.button("undo", "undo", "undo2", false, !this.history.length || !!this.pending)}${this.button("preview", this.preview ? "edit" : "preview", "eye", false, !!this.pending)}${this.button("cancel", "cancel", "", false, !!this.pending)}${this.button("save", this.saving ? "saving" : this.pending ? "retry" : innerWidth < 768 ? "done" : "save", "", true, this.saving)}</div>`
        : `<div><h1>${gt(this.t, "headline")}</h1></div>${this.button("customize", "customize", "slidersHorizontal", false, !this.ready)}`,
    );
    if (this.error) {
      setMessageHtml(
        this.feedback,
        `${e(gt(this.t, this.error as GadgetMessage))} ${this.error === "conflict" ? this.button("reload-saved", "loadSaved") : this.pending ? "" : this.button("retry-load", "retry")}`,
      );
    } else if (!this.ready) this.feedback.textContent = gt(this.t, "loading");
    else if (this.editing) this.feedback.textContent = gt(this.t, this.changed ? "unsaved" : "layoutHelp");
    else this.feedback.textContent = this.noticeMessage;
    let items = this.layout.items.filter((i) => i.visible[this.mobile ? "mobile" : "desktop"]);
    if (this.mobile)
      items = items.toSorted((a, b) => this.layout.mobileOrder.indexOf(a.id) - this.layout.mobileOrder.indexOf(b.id));
    const present = new Set(items.map((i) => i.id));
    this.mounts.retain(present);
    const placeholder = this.canvas.querySelector(".gadget-empty-canvas");
    placeholder?.remove();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "gadget-empty-canvas";
      setMessageHtml(
        empty,
        `<strong>${gt(this.t, "emptyCanvas")}</strong><p>${gt(this.t, "emptyCanvasHint")}</p>${this.button(this.editing ? "library" : "customize", "addWidget", "plus")}`,
      );
      this.canvas.append(empty);
    }
    items.forEach((item, index) => this.renderInstance(item, index, edit));
    this.panel.hidden = !edit;
    if (edit) {
      if (!preserveControls) this.editor.render(this.panel);
    } else this.panel.replaceChildren();
    setMessageHtml(
      this.controls,
      this.editing
        ? this.button("library", "addWidget", "plus", false, !!this.pending) +
            this.button("layout", "layoutSettings", "slidersHorizontal", false, !!this.pending) +
            this.button("preview", this.preview ? "edit" : "preview", "eye", false, !!this.pending)
        : "",
    );
  }
  private renderInstance(instance: GadgetInstance, index: number, edit: boolean) {
    const mounted = this.mounts.ensure(instance.id),
      manifest = this.manifests.find((m) => m.id === instance.gadget);
    const { element } = mounted;
    element.dataset.gadgetTypeId = instance.gadget;
    element.classList.toggle("is-selected", this.selected === instance.id);
    Object.entries({
      "--gadget-x": instance.x + 1,
      "--gadget-y": instance.y + 1,
      "--gadget-w": instance.w,
      "--gadget-h": instance.h,
    }).forEach(([k, v]) => element.style.setProperty(k, String(v)));
    const title = instance.title || (manifest ? gadgetName(manifest.title, this.locale()) : instance.gadget);
    element.setAttribute("aria-label", title);
    const heading = element.querySelector<HTMLElement>(".gadget-instance-heading")!;
    setMessageHtml(
      heading,
      `${edit ? `<button class="icon-button gadget-handle" draggable="true" data-gadget-handle="${instance.id}" aria-label="${e(gt(this.t, "move") + ": " + title)}" title="${gt(this.t, "keyboardHint")}">${codexIcon("gripVertical")}</button>` : manifest ? `<span class="gadget-heading-icon">${codexIcon(manifest.icon)}</span>` : ""}<h2 data-i18n-ignore>${e(title)}</h2>${edit ? `<span class="gadget-order-tools">${this.button("up", "moveUp", "chevronUp", false, this.layout.mobileOrder[0] === instance.id, `data-id="${instance.id}"`)}${this.button("down", "moveDown", "chevronDown", false, this.layout.mobileOrder.at(-1) === instance.id, `data-id="${instance.id}"`)}</span>${this.button("config", "widgetSettings", "slidersHorizontal", false, !!this.pending, `data-id="${instance.id}"`)}${this.button("remove", "remove", "x", false, !!this.pending, `data-id="${instance.id}"`)}` : manifest ? `<button type="button" class="icon-button gadget-help" title="${e(gadgetName(manifest.description, this.locale()))}" aria-label="${e(gadgetName(manifest.description, this.locale()))}">${codexIcon("circleHelp")}</button>` : ""}`,
    );
    element.querySelector(".gadget-resize")?.remove();
    if (edit) {
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "gadget-resize";
      resize.dataset.gadgetResize = instance.id;
      resize.setAttribute("aria-label", gt(this.t, "resize"));
      resize.innerHTML = codexIcon("expand");
      element.append(resize);
    }
    if (this.canvas.children[index] !== element) this.canvas.insertBefore(element, this.canvas.children[index] ?? null);
    if (!manifest || instance.configVersion !== manifest.configVersion) {
      this.mounts.fail(instance.id, manifest ? "incompatible" : "missing", false);
      return;
    }
    this.mounts.update(instance, manifest);
  }
}
