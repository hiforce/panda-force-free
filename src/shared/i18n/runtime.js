import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { englishMessages } from "./catalogs.js";
import { createFormatters } from "./formatters.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocale, validPreference } from "./locale-policy.js";
import { validateNamespace } from "./message-contract.js";

const messageParts = (resources, id) => {
  for (const [namespace, messages] of Object.entries(resources))
    if (id.startsWith(namespace + ".") && Object.hasOwn(messages, id.slice(namespace.length + 1)))
      return [namespace, id.slice(namespace.length + 1)];
  return null;
};
const hasMessage = (resources, id) => Boolean(messageParts(resources, id));
// Resource stores are mutable inside the engine. Never share them across owners.
const copyCatalog = (messages) =>
  Object.fromEntries(Object.entries(messages).map(([name, values]) => [name, { ...values }]));
/** @param {import("./contracts.js").I18nOptions} options */
export function createI18nRuntime({
  preference = "system",
  languages = [],
  registry = SUPPORTED_LOCALES,
  loaders = {},
  resources = {},
  persist = () => {},
  onMissing = () => {},
  onLoadError = () => {},
  timeZone,
} = {}) {
  const engine = createInstance().use(ICU);
  const dictionaries = Object.fromEntries(
    Object.entries({ en: englishMessages, ...resources }).map(([code, messages]) => [code, copyCatalog(messages)]),
  );
  const loading = new Map(),
    listeners = new Set();
  let browserLanguages = [...languages];
  let currentPreference = validPreference(preference, registry) ? preference : "system",
    generation = 0;
  let locale = dictionaries[resolveLocale(currentPreference, browserLanguages, registry)]
    ? resolveLocale(currentPreference, browserLanguages, registry)
    : "en";
  engine.init({
    initAsync: false,
    lng: locale,
    fallbackLng: "en",
    resources: Object.fromEntries(Object.entries(dictionaries).map(([code, messages]) => [code, messages])),
    ns: Object.keys(englishMessages),
    defaultNS: "common",
    keySeparator: false,
    interpolation: { escapeValue: false },
    i18nFormat: {
      bindI18nStore: "added",
      parseErrorHandler(error) {
        throw error;
      },
    },
    returnNull: false,
    returnEmptyString: false,
  });
  const format = createFormatters(() => ({ locale, timeZone }));
  const ensure = (code) => {
    if (dictionaries[code]) return Promise.resolve(dictionaries[code]);
    if (!loaders[code]) return Promise.resolve(null);
    if (!loading.has(code))
      loading.set(
        code,
        Promise.resolve()
          .then(loaders[code])
          .then((messages) => {
            if (!messages || typeof messages !== "object" || Array.isArray(messages))
              throw new Error("Invalid language pack");
            for (const [namespace, entries] of Object.entries(messages)) {
              if (!Object.hasOwn(dictionaries.en, namespace)) throw new Error("Unknown language namespace");
              validateNamespace(dictionaries.en[namespace], { [code]: entries });
            }
            dictionaries[code] = copyCatalog(messages);
            for (const [namespace, values] of Object.entries(dictionaries[code]))
              engine.addResourceBundle(code, namespace, values, true, true);
            return messages;
          })
          .catch((error) => {
            onLoadError(code, error);
            return null;
          })
          .finally(() => loading.delete(code)),
      );
    return loading.get(code);
  };
  function t(id, values = {}) {
    if (typeof id !== "string") return String(id ?? "");
    const parts = messageParts(dictionaries[locale] || {}, id) || messageParts(dictionaries.en, id);
    if (!parts) {
      // Provider text is opaque. Only explicit message IDs enter translation.
      if (Object.keys(dictionaries.en).some((namespace) => id.startsWith(namespace + "."))) {
        onMissing(id, locale);
        return "Message unavailable";
      }
      return id;
    }
    const [namespace, key] = parts;
    try {
      return String(engine.t(key, { ...values, ns: namespace, lng: locale }));
    } catch (error) {
      onMissing(id, locale, error);
      try {
        return String(engine.t(key, { ...values, ns: namespace, lng: "en" }));
      } catch {
        return String(engine.t("messageUnavailable", { ns: "common", lng: "en" }));
      }
    }
  }
  const api = {
    t: /** @type {import("./messages.js").Translate} */ (t),
    format,
    get preference() {
      return currentPreference;
    },
    get locale() {
      return locale;
    },
    get direction() {
      return registry.find((entry) => entry.code === locale)?.direction || "ltr";
    },
    get locales() {
      return registry;
    },
    has: (id) => hasMessage(dictionaries.en, id),
    async setPreference(next, { save = true } = {}) {
      if (!validPreference(next, registry)) return false;
      const ticket = ++generation,
        target = resolveLocale(next, browserLanguages, registry);
      const available = await ensure(target);
      if (ticket !== generation) return false;
      currentPreference = next;
      locale = available ? target : DEFAULT_LOCALE;
      await engine.changeLanguage(locale);
      if (save) persist(next);
      for (const listener of listeners) listener(locale, currentPreference);
      return true;
    },
    setLanguages(next) {
      browserLanguages = Array.isArray(next) ? [...next] : [];
      return api.setPreference(currentPreference, { save: false });
    },
    setTimeZone(next) {
      new Intl.DateTimeFormat(locale, { timeZone: next });
      timeZone = next;
      for (const listener of listeners) listener(locale, currentPreference);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async registerNamespace(owner, { en, translations = {} }) {
      if (!/^(?:plugin\.)[a-z][a-z0-9-]+$/.test(owner) || dictionaries.en[owner])
        throw new Error("Invalid or duplicate plugin namespace");
      validateNamespace(en, translations);
      if (Object.keys(translations).some((code) => !registry.some((entry) => entry.code === code)))
        throw new Error("Unknown plugin locale");
      en = { ...en };
      translations = Object.fromEntries(
        Object.entries(translations).map(([code, messages]) => [code, { ...messages }]),
      );
      dictionaries.en = { ...dictionaries.en, [owner]: en };
      engine.addResourceBundle("en", owner, en, true, false);
      for (const [code, messages] of Object.entries(translations)) {
        await ensure(code);
        dictionaries[code] = { ...(dictionaries[code] || {}), [owner]: messages };
        engine.addResourceBundle(code, owner, messages, true, false);
      }
    },
  };
  api.ready = api.setPreference(currentPreference, { save: false });
  return api;
}
