import type { Translate } from "../shared/i18n/messages.js";
import { presentationText, type PresentationLabel } from "../shared/presentation/labels.js";

export const presentationLabel = (t: Translate, value: PresentationLabel, field: "name" | "description" = "name") =>
  presentationText(t, value, field, globalThis.document?.documentElement.lang || "en");
