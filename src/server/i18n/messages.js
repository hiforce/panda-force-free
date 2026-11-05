import { resolveLocale } from "../../shared/i18n/locale-policy.js";
import { createI18nRuntime } from "../../shared/i18n/runtime.js";
import { serverMessages } from "../../shared/i18n/server-catalogs.js";
const translators = new Map();
export function serverTranslator(locale = "en") {
  locale = resolveLocale(locale, []);
  if (!translators.has(locale))
    translators.set(locale, createI18nRuntime({ preference: locale, resources: serverMessages }).t);
  return translators.get(locale);
}
