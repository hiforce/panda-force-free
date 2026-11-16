import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentTemplateDefinition } from "../../../shared/templates/authoring/contracts.js";
import type { TemplateParameter } from "../../../shared/templates/portable/contracts.js";
import { setMessageHtml } from "../../i18n.js";
import { fieldValue, parameterRow, parameterTypeFields, readParameter, slotRow, optionRow } from "./fields.js";

/** Structured fields mutate only their own row; typing elsewhere never rebuilds the rich document or loses focus. */
export class TemplateStructureFields {
  private nextParameter = 0;
  private nextSlot = 0;
  private nextOption = 1000;
  private parameters = new Map<number, TemplateParameter>();
  constructor(
    private host: HTMLElement,
    private t: Translate,
    private changed: () => void,
    private insert: (token: string) => void,
  ) {}
  mount(value: DocumentTemplateDefinition) {
    for (const item of value.parameters) this.addParameter(item);
    for (const item of value.contentSlots) this.addSlot(item);
    this.host.addEventListener("click", this.click);
    this.host.addEventListener("change", this.change);
  }
  read() {
    return {
      parameters: [...this.host.querySelectorAll<HTMLElement>("[data-parameter-index]")].map((row) =>
        readParameter(row, this.parameters.get(Number(row.dataset.parameterIndex))),
      ),
      contentSlots: [...this.host.querySelectorAll<HTMLElement>("[data-slot-index]")].map((row) => ({
        id: fieldValue(row, "slot-id"),
        kind: fieldValue(row, "slot-kind") as "rich-text" | "plain-text",
        default: fieldValue(row, "slot-default"),
      })),
    };
  }
  destroy() {
    this.host.removeEventListener("click", this.click);
    this.host.removeEventListener("change", this.change);
  }
  private freshId(prefix: string) {
    const current = this.read(),
      ids = new Set([...current.parameters, ...current.contentSlots].map((item) => item.id));
    let index = 1;
    while (ids.has(prefix + index)) index++;
    return prefix + index;
  }
  private addParameter(value?: TemplateParameter) {
    if (this.host.querySelectorAll("[data-parameter-index]").length >= 64) return;
    const item = value || {
        id: this.freshId("parameter"),
        label: { en: "Parameter" },
        required: false,
        type: "text" as const,
      },
      index = this.nextParameter++;
    const wrapper = document.createElement("div");
    setMessageHtml(wrapper, parameterRow(this.t, item, index));
    this.host.querySelector("[data-authoring-parameters]")!.append(...wrapper.childNodes);
    this.parameters.set(index, item);
  }
  private addSlot(value?: DocumentTemplateDefinition["contentSlots"][number]) {
    if (this.host.querySelectorAll("[data-slot-index]").length >= 64) return;
    const item = value || { id: this.freshId("section"), kind: "rich-text" as const, default: "" },
      wrapper = document.createElement("div");
    setMessageHtml(wrapper, slotRow(this.t, item, this.nextSlot++));
    this.host.querySelector("[data-authoring-slots]")!.append(...wrapper.childNodes);
  }
  private click = (event: Event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-authoring-field-action]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.authoringFieldAction,
      row = button.closest<HTMLElement>("[data-parameter-index],[data-slot-index]");
    if (action === "add-parameter") this.addParameter();
    else if (action === "add-slot") this.addSlot();
    else if (action === "remove-parameter" || action === "remove-slot") row?.remove();
    else if (action === "remove-choice") button.closest("[data-choice-index]")?.remove();
    else if (action === "add-choice" && row) {
      const list = row.querySelector("[data-parameter-options]")!,
        index = list.querySelectorAll("[data-choice-index]").length;
      if (index >= 64) return;
      const values = new Set(
        [...list.querySelectorAll<HTMLElement>("[data-choice-index]")].map((option) =>
          fieldValue(option, "choice-value"),
        ),
      );
      let serial = 1;
      while (values.has("option-" + serial)) serial++;
      const wrapper = document.createElement("div");
      setMessageHtml(
        wrapper,
        optionRow(this.t, { value: "option-" + serial, label: { en: "Option " + serial } }, this.nextOption++),
      );
      list.append(...wrapper.childNodes);
    } else if (action === "insert-parameter" || action === "insert-slot") {
      const id = row ? fieldValue(row, action === "insert-parameter" ? "parameter-id" : "slot-id") : "";
      if (/^[a-z][a-z0-9_-]*$/.test(id)) this.insert("{{" + id + "}}");
    }
    this.changed();
  };
  private change = (event: Event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.dataset.field !== "parameter-type") return;
    const row = select.closest<HTMLElement>("[data-parameter-index]")!;
    const previous = readParameter(row, this.parameters.get(Number(row.dataset.parameterIndex))),
      base = { id: previous.id, label: previous.label, required: previous.required };
    const value: TemplateParameter =
      select.value === "choice"
        ? { ...base, type: "choice", options: [{ value: "option-1", label: { en: "Option 1" } }] }
        : select.value === "number"
          ? { ...base, type: "number" }
          : select.value === "boolean"
            ? { ...base, type: "boolean" }
            : { ...base, type: "text" };
    setMessageHtml(row.querySelector("[data-parameter-type-fields]")!, parameterTypeFields(this.t, value));
    this.parameters.set(Number(row.dataset.parameterIndex), value);
    this.changed();
  };
}
