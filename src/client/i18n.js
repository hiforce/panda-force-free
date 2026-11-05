// The public facade stays independent of the selected message engine.
export { resolveLocale } from "../shared/i18n/locale-policy.js";
export { createI18nRuntime } from "../shared/i18n/runtime.js";
export {
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  bindMessages,
  createI18n,
  getBrowserI18n,
  localizeAttribute,
  localizeText,
  messageAttributes,
  messageHtml,
  setMessageHtml,
  setOpaqueAttribute,
  setOpaqueText,
} from "./i18n/browser-runtime.js";
export { errorText } from "./i18n/errors.js";
