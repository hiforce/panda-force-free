import type { Translate } from "../../shared/i18n/messages.js";
import { createRuntimeModelField } from "../harness/model-field.js";

export const createBotModelField = (t: Translate, changed?: () => void) =>
  createRuntimeModelField(t, "pf-bot", changed, "bots");
