// The public facade stays independent of the selected message engine.
export {
  createI18n,
  getBrowserI18n,
  localizeText,
  localizeAttribute,
  bindMessages,
  setMessageHtml,
  messageHtml,
  messageAttributes,
  setOpaqueText,
  setOpaqueAttribute,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
} from "./i18n/browser-runtime.js";
export { resolveLocale } from "../shared/i18n/locale-policy.js";
export { createI18nRuntime } from "../shared/i18n/runtime.js";
export { errorText } from "./i18n/errors.js";
