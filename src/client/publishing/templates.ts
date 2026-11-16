import type { ChannelTemplateDescriptor } from "../../shared/presentation/templates.js";
import { templateReference } from "../../shared/presentation/templates.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { presentationLabel } from "../presentation-labels.js";
import { setMessageHtml } from "../i18n.js";
import { styleCard } from "../publishing-styles/views.js";

export function templateOptions(t: Translate, templates: ChannelTemplateDescriptor[], selected: string) {
  const known = templates.some((item) => templateReference(item) === selected);
  return (
    (!known && selected
      ? `<option value="${e(selected)}" selected>${e(selected)} · ${e(t("publishing.unknownTemplate"))}</option>`
      : "") +
    templates
      .map(
        (item) =>
          `<option value="${e(templateReference(item))}" ${templateReference(item) === selected ? "selected" : ""}>${e(presentationLabel(t, item))} · ${e(item.version)}</option>`,
      )
      .join("")
  );
}

export function templateChoices(
  host: HTMLElement,
  t: Translate,
  templates: ChannelTemplateDescriptor[],
  selected: string,
) {
  const choices = host.querySelector<HTMLElement>("#publicationTemplateChoices");
  if (!choices) return;
  setMessageHtml(
    choices,
    templates
      .map((value) => styleCard(t, { kind: "channel", value }, templateReference(value) === selected, "select"))
      .join(""),
  );
  choices.onclick = (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!button || button.disabled) return;
    const template = templates.find((item) => `channel:${templateReference(item)}` === button.dataset.styleKey);
    if (!template) return;
    const select = host.querySelector<HTMLSelectElement>("#publicationTemplate")!;
    select.value = templateReference(template);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
}
