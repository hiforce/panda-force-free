import { validTemplateSnapshot, type TemplateSnapshot } from "./template-snapshot.js";
import type { MessageId } from "../i18n/messages.js";
import type { PublicationFormat } from "../publishing/content.js";
import type { PresentationLabel } from "./labels.js";
export type TemplateName = "editorial" | "technical" | "minimal";
export const templates = Object.freeze({
  editorial: { version: "1", font: "Georgia,serif", color: "#272a32", accent: "#4c55b8", width: "720px", size: "17px" },
  technical: {
    version: "1",
    font: "Arial,sans-serif",
    color: "#202532",
    accent: "#2863a7",
    width: "820px",
    size: "16px",
  },
  minimal: {
    version: "1",
    font: "Arial,sans-serif",
    color: "#222222",
    accent: "#222222",
    width: "680px",
    size: "16px",
  },
});

export interface ChannelTemplateDescriptor extends TemplateSnapshot, PresentationLabel {
  formats: PublicationFormat[];
}
export interface ChannelTemplateCatalog {
  list(): ChannelTemplateDescriptor[];
  resolve(id: string, version?: string): ChannelTemplateDescriptor;
}
export type TemplateSelection = TemplateName | TemplateSnapshot;
export class TemplateSelectionError extends Error {
  constructor(readonly code: "unknownTemplate" | "staleTemplate" | "invalidTemplate") {
    super(code);
  }
}
const formats: PublicationFormat[] = ["html", "plain", "x-post", "x-thread", "x-article", "wechat", "toutiao"];
const labels: Record<TemplateName, MessageId> = {
  editorial: "publishing.templateEditorial",
  technical: "publishing.templateTechnical",
  minimal: "publishing.templateMinimal",
};
/** Declarative templates have a closed style vocabulary; plugin metadata cannot inject CSS or HTML. */
export function validateChannelTemplate(input: ChannelTemplateDescriptor): ChannelTemplateDescriptor {
  let snapshot: TemplateSnapshot;
  try {
    snapshot = validTemplateSnapshot(input);
  } catch {
    throw new TemplateSelectionError("invalidTemplate");
  }
  if (
    !(
      (typeof input.nameId === "string" && input.nameId) ||
      (typeof input.name === "string" && input.name.trim() && input.name.length <= 120)
    ) ||
    !Array.isArray(input.formats) ||
    !input.formats.length ||
    input.formats.some((item) => !formats.includes(item))
  )
    throw new TemplateSelectionError("invalidTemplate");
  return {
    ...snapshot,
    ...(input.nameId
      ? { nameId: input.nameId }
      : {
          name: input.name,
          description: input.description,
          labels: input.labels ? structuredClone(input.labels) : undefined,
        }),
    formats: [...new Set(input.formats)],
  };
}
const builtinList = () =>
  (Object.keys(templates) as TemplateName[]).map((id) =>
    validateChannelTemplate({
      id,
      version: templates[id].version,
      nameId: labels[id],
      formats,
      style: { ...templates[id] },
    }),
  );
export const builtinChannelTemplates: ChannelTemplateCatalog = {
  list: builtinList,
  resolve(id, version) {
    const selected = builtinList().find((item) => item.id === id);
    if (!selected) throw new TemplateSelectionError("unknownTemplate");
    if (version !== undefined && selected.version !== version) throw new TemplateSelectionError("staleTemplate");
    return selected;
  },
};
export const templateDescriptor = (value: TemplateSelection): TemplateSnapshot =>
  validTemplateSnapshot(typeof value === "string" ? builtinChannelTemplates.resolve(value) : value);
export const templateReference = (value: Pick<ChannelTemplateDescriptor, "id" | "version">) =>
  `${value.id}@${value.version}`;
