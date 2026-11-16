import type { Translate } from "../../../shared/i18n/messages.js";
import { validTemplateSnapshot, type ChannelTemplateStyle } from "../../../shared/presentation/template-snapshot.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml } from "../../i18n.js";

interface EditableStyle {
  id: string;
  name: string;
  style: Omit<ChannelTemplateStyle, "version">;
}
function channelStyles(value: unknown): EditableStyle[] {
  if (!value || typeof value !== "object" || !("channelTemplates" in value) || !Array.isArray(value.channelTemplates))
    return [];
  return value.channelTemplates.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("style" in entry) ||
      !entry.style ||
      typeof entry.style !== "object"
    )
      throw Error("Invalid style");
    const { version: _version, ...style } = validTemplateSnapshot({
      id: "editor",
      version: "1",
      style: { ...entry.style, version: "1" } as ChannelTemplateStyle,
    }).style;
    return { id: entry.id, name: entry.name, style };
  });
}

/** The JSON working definition stays authoritative; fields apply one validated style patch to it. */
export function bindChannelStyleFields(host: HTMLElement, source: HTMLTextAreaElement, t: Translate) {
  const realm = host.ownerDocument.defaultView;
  const ElementClass = realm?.Element ?? Element;
  const SelectClass = realm?.HTMLSelectElement ?? HTMLSelectElement;
  const InputClass = realm?.HTMLInputElement ?? HTMLInputElement;
  const EventClass = realm?.Event ?? Event;
  let selected = "",
    writing = false;
  function render() {
    let entries: EditableStyle[];
    try {
      entries = channelStyles(JSON.parse(source.value));
    } catch {
      host.textContent = t("plugins.stylesFieldsInvalid");
      return;
    }
    host.hidden = entries.length === 0;
    if (!entries.length) return;
    const entry = entries.find((item) => item.id === selected) || entries[0]!;
    selected = entry.id;
    const options = (values: string[], value: string) =>
      values
        .map((option) => `<option value="${e(option)}" ${option === value ? "selected" : ""}>${e(option)}</option>`)
        .join("");
    setMessageHtml(
      host,
      `<details open><summary>${e(t("plugins.stylesFieldsTitle"))}</summary><label>${e(t("plugins.stylesFieldsTemplate"))}<select data-style-entry>${entries.map((item) => `<option value="${e(item.id)}" ${item.id === selected ? "selected" : ""}>${e(item.name)}</option>`).join("")}</select></label><div class="library-field-grid"><label>${e(t("plugins.stylesFieldsFont"))}<select data-style-field="font">${options(["Arial,sans-serif", "Georgia,serif", "system-ui,sans-serif"], entry.style.font)}</select></label><label>${e(t("plugins.stylesFieldsSize"))}<select data-style-field="size">${options(
        Array.from({ length: 9 }, (_, index) => `${14 + index}px`),
        entry.style.size,
      )}</select></label><label>${e(t("plugins.stylesFieldsColor"))}<input type="color" data-style-field="color" value="${e(entry.style.color)}"></label><label>${e(t("plugins.stylesFieldsAccent"))}<input type="color" data-style-field="accent" value="${e(entry.style.accent)}"></label><label>${e(t("plugins.stylesFieldsWidth"))}<select data-style-field="width">${options(
        Array.from({ length: 33 }, (_, index) => `${640 + index * 10}px`),
        entry.style.width,
      )}</select></label></div></details>`,
    );
  }
  host.addEventListener("change", (event) => {
    if (!(event.target instanceof SelectClass) || !event.target.matches("[data-style-entry]")) return;
    selected = event.target.value;
    render();
  });
  host.addEventListener("input", (event) => {
    const field = event.target;
    if (field instanceof ElementClass && field.matches("[data-style-entry]")) {
      event.stopPropagation();
      return;
    }
    if (!(field instanceof InputClass || field instanceof SelectClass) || !field.dataset.styleField) return;
    try {
      const raw: unknown = JSON.parse(source.value);
      const entries = channelStyles(raw),
        entry = entries.find((item) => item.id === selected);
      if (
        !entry ||
        !raw ||
        typeof raw !== "object" ||
        !("channelTemplates" in raw) ||
        !Array.isArray(raw.channelTemplates)
      )
        return;
      const key = field.dataset.styleField;
      if (!["font", "size", "color", "accent", "width"].includes(key)) return;
      const style = validTemplateSnapshot({
        id: "editor",
        version: "1",
        style: { ...entry.style, [key]: field.value, version: "1" },
      }).style;
      const { version: _version, ...safe } = style;
      raw.channelTemplates = raw.channelTemplates.map((item: Record<string, unknown>) =>
        item.id === selected ? { ...item, style: safe } : item,
      );
      writing = true;
      source.value = JSON.stringify(raw, null, 2);
      source.dispatchEvent(new EventClass("input", { bubbles: true }));
      event.stopPropagation();
    } catch {
      host.textContent = t("plugins.stylesFieldsInvalid");
    } finally {
      writing = false;
    }
  });
  source.addEventListener("input", () => {
    if (!writing) render();
  });
  render();
}
