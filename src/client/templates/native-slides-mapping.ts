import type { Translate } from "../../shared/i18n/messages.js";
import type { NativeSlidesSourceReference } from "../../shared/slides/registry.js";
import type { NativePresentationIndex, NativeSlidePart } from "../../shared/slides/contracts.js";
import type { NativeContentMapping } from "../../shared/slides/mapping.js";
import { setMessageHtml, errorText } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";

import { PluginApiError } from "../plugins/api.js";
import { nativeSlidesApi as api } from "./native-slides-api.js";
import { editableNativeObjects, NativeSlidesMappingDraft } from "./native-slides-mapping-model.js";

/** Part reads, object paging and slot edits have separate lifetimes; only the draft is the editable mapping authority. */
export function createNativeSlidesMapping(
  t: Translate,
  host: HTMLElement,
  source: NativeSlidesSourceReference,
  original: NativePresentationIndex,
  seed: NativeContentMapping | undefined,
  changed: () => void,
) {
  const draft = new NativeSlidesMappingDraft(original.source.sha256, seed);
  let epoch = 0,
    disposed = false,
    part: NativeSlidePart | null = null,
    shown = 0;
  let objects: ReturnType<typeof editableNativeObjects> = [];
  const get = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const groups = [
    ["templates.officeLayouts", original.layouts],
    ["templates.officeSlides", original.slides],
  ] as const;
  setMessageHtml(
    host,
    `<h4>${e(t("templates.officeMapping"))}</h4><p>${e(t("templates.officeMappingHint"))}</p><label class="wb-field">${e(t("templates.officeEmptySelection"))}<select data-office-part>${groups.map(([label, values]) => `<optgroup label="${e(t(label))}">${values.map((value) => `<option value="${e(value.path)}">${e(value.name || value.path)}</option>`).join("")}</optgroup>`).join("")}</select></label><p role="status" data-office-part-notice></p><p data-office-slot-count></p><div class="office-object-list" data-office-objects></div><button type="button" class="wb-button" data-office-more hidden>${e(t("templates.officeMoreObjects"))}</button>`,
  );
  function count() {
    get("[data-office-slot-count]").textContent = t("templates.officeMappedCount", { count: draft.count() });
  }
  function append() {
    if (!part) return;
    const end = Math.min(shown + 60, objects.length),
      nodes = document.createElement("div");
    setMessageHtml(
      nodes,
      objects
        .slice(shown, end)
        .map(({ shape, kind }) => {
          const slot = draft.get(part!.path, shape.id);
          return `<article class="office-object" data-office-shape="${e(shape.id)}"><label class="wb-choice office-object-toggle"><input type="checkbox" data-office-map ${slot ? "checked" : ""}><span><strong data-i18n-ignore>${e(shape.name)}</strong><small>${e(t(kind === "text" ? "templates.officeText" : "templates.officeImage"))} #${e(shape.id)}</small></span></label>${shape.text ? `<p class="office-object-sample" data-i18n-ignore>${e(shape.text.slice(0, 180))}</p>` : ""}<fieldset class="wb-form-grid" data-office-slot-fields ${slot ? "" : "disabled"}><label class="wb-field">${e(t("templates.officeSlotId"))}<input data-office-slot="id" value="${e(slot?.id || "")}" required pattern="[a-z](?:[a-z0-9_]|-){0,63}" maxlength="64" spellcheck="false"></label><label class="wb-field">${e(t("templates.officeSlotLabel"))}<input data-office-slot="label" value="${e(slot?.label || "")}" required maxlength="256"></label><label class="wb-choice office-required"><input type="checkbox" data-office-slot="required" ${slot?.required ? "checked" : ""}>${e(t("templates.officeRequired"))}</label></fieldset></article>`;
        })
        .join(""),
    );
    get("[data-office-objects]").append(...nodes.childNodes);
    shown = end;
    get<HTMLButtonElement>("[data-office-more]").hidden = shown >= objects.length;
  }
  async function read() {
    const generation = ++epoch,
      selected = get<HTMLSelectElement>("[data-office-part]").value;
    get("[data-office-objects]").replaceChildren();
    part = null;
    shown = 0;
    get<HTMLButtonElement>("[data-office-more]").hidden = true;
    if (!selected) return;
    get("[data-office-part-notice]").textContent = t("plugins.working");
    try {
      const value = await api.part(source, selected);
      if (disposed || generation !== epoch) return;
      part = value;
      objects = editableNativeObjects(value.shapes);
      append();
      get("[data-office-part-notice]").textContent = objects.length ? "" : t("templates.officeNoObjects");
    } catch (error) {
      if (!disposed && generation === epoch)
        get("[data-office-part-notice]").textContent = errorText(
          error instanceof PluginApiError ? error.payload : null,
          t,
          "templates.officePartUnavailable",
        );
    }
  }
  function edit(event: Event) {
    if (
      !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) ||
      (!part && !event.target.matches("[data-office-part]"))
    )
      return;
    if (event.target.matches("[data-office-part]")) {
      void read();
      return;
    }
    const row = event.target.closest<HTMLElement>("[data-office-shape]"),
      current = objects.find((value) => value.shape.id === row?.dataset.officeShape);
    if (!row || !current || !part) return;
    try {
      if (event.target.matches("[data-office-map]")) {
        const selected = (event.target as HTMLInputElement).checked;
        draft.select(part.path, current.shape, current.kind, selected);
        row.querySelector<HTMLFieldSetElement>("[data-office-slot-fields]")!.disabled = !selected;
        const slot = draft.get(part.path, current.shape.id);
        row.querySelector<HTMLInputElement>('[data-office-slot="required"]')!.checked = slot?.required || false;
        for (const field of ["id", "label"] as const)
          row.querySelector<HTMLInputElement>(`[data-office-slot="${field}"]`)!.value = slot?.[field] || "";
      } else
        draft.update(part.path, current.shape.id, {
          id: row.querySelector<HTMLInputElement>('[data-office-slot="id"]')!.value.trim(),
          label: row.querySelector<HTMLInputElement>('[data-office-slot="label"]')!.value,
          required: row.querySelector<HTMLInputElement>('[data-office-slot="required"]')!.checked,
        });
      count();
      changed();
    } catch {
      row.querySelector<HTMLInputElement>("[data-office-map]")!.checked = Boolean(
        draft.get(part.path, current.shape.id),
      );
      get("[data-office-part-notice]").textContent = t("templates.officeInvalidMapping");
    }
  }
  host.onchange = edit;
  host.oninput = (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") edit(event);
  };
  host.onclick = (event) => {
    if (event.target instanceof Element && event.target.closest("[data-office-more]")) append();
  };
  const initial = seed?.slots[0]?.target.part;
  if (initial) get<HTMLSelectElement>("[data-office-part]").value = initial;
  count();
  void read();
  return {
    snapshot: () => draft.snapshot(),
    dispose() {
      disposed = true;
      epoch++;
      host.onchange = host.onclick = host.oninput = null;
      host.replaceChildren();
    },
  };
}
