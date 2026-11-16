import type { MessageId, Translate } from "../i18n/messages.js";
import { localizedText } from "./localized.js";

/** Installed names are plain data, with an English fallback independent of the core message catalog. */
export interface PresentationLabel {
  nameId?: MessageId;
  descriptionId?: MessageId;
  name?: string;
  description?: string;
  labels?: Record<string, { name: string; description: string }>;
}
export function presentationText(
  t: Translate,
  value: PresentationLabel,
  field: "name" | "description" = "name",
  locale = "en",
): string {
  const message = field === "name" ? value.nameId : value.descriptionId;
  if (message) return t(message);
  return (
    localizedText(
      Object.fromEntries(Object.entries(value.labels || {}).map(([key, item]) => [key, item[field]])),
      locale,
    ) ||
    value[field] ||
    ""
  );
}
