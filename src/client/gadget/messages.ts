import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type strings from "../../shared/i18n/locales/en/gadget.json";
export type GadgetMessage = keyof typeof strings;
export const gt = (t: Translate, key: GadgetMessage) => t(("gadget." + key) as MessageId);
