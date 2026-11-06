import { escapeHtml as escapeMessage } from "../../shared/html.js";
import {
  LOCALE_PREFERENCE_KEY,
  readLocaleCookie,
  SUPPORTED_LOCALES,
  validPreference,
} from "../../shared/i18n/locale-policy.js";
import { createI18nRuntime } from "../../shared/i18n/runtime.js";
import { englishMessages } from "../../shared/i18n/catalogs.js";
import { sanitizeInterfaceHtml } from "../html-safety.js";
import { request as fetch } from "./../http-client.js";
import { clearMessageBinding, createMessageBindings } from "./bindings.js";

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
function cookieOf(doc) {
  try {
    return doc?.cookie || "";
  } catch {
    return "";
  }
}

const SLOT = Symbol.for("PandaForce.browserI18n");
const messageOwners = new WeakMap();
const compatibleOwners = new WeakSet();
const requiredMessages = Object.entries(englishMessages).flatMap(([namespace, messages]) =>
  Object.keys(messages).map((key) => namespace + "." + key),
);
/** @param {import("../../shared/i18n/contracts.js").BrowserI18nOptions} options */
export function createI18n({
  storage = defaultStorage(),
  languages = globalThis.navigator?.languages || [],
  document: doc = globalThis.document,
  ...options
} = {}) {
  const registry = options.registry || SUPPORTED_LOCALES;
  let stored;
  try {
    stored = storage?.getItem?.(LOCALE_PREFERENCE_KEY);
  } catch {}
  const preference =
    readLocaleCookie(cookieOf(doc), registry) ||
    (typeof stored === "string" && validPreference(stored, registry) ? stored : "system");
  const persist = (value) => {
    try {
      storage?.setItem?.(LOCALE_PREFERENCE_KEY, value);
    } catch {}
    try {
      if (doc)
        doc.cookie = `${LOCALE_PREFERENCE_KEY}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${globalThis.location?.protocol === "https:" ? "; Secure" : ""}`;
    } catch {}
  };
  const loaders = Object.fromEntries(
    (options.registry || SUPPORTED_LOCALES)
      .filter((entry) => entry.code !== "en")
      .map((entry) => [
        entry.code,
        async () => {
          const version = typeof PANDA_LOCALE_VERSION === "undefined" ? "development" : PANDA_LOCALE_VERSION;
          const response = await fetch(`/locales/${entry.code}.json?v=${version}`, {
            signal: AbortSignal.timeout(8000),
            cache: "force-cache",
          });
          if (!response.ok) throw new Error("Language pack unavailable");
          return response.json();
        },
      ]),
  );
  const runtime = createI18nRuntime({ preference, languages, persist, loaders, ...options });
  runtime.bindings = createMessageBindings(runtime);
  messageOwners.set(runtime.t, runtime.bindings);
  runtime.subscribe(() => {
    if (doc?.documentElement) {
      doc.documentElement.lang = runtime.locale;
      doc.documentElement.dir = runtime.direction;
    }
  });
  const events = doc?.defaultView;
  const languageChanged = () =>
    runtime.preference === "system" && runtime.setLanguages(events?.navigator?.languages || languages);
  const storageChanged = (event) => {
    if (event.key === LOCALE_PREFERENCE_KEY && (event.newValue === null || validPreference(event.newValue, registry)))
      void runtime.setPreference(event.newValue || "system", { save: false });
  };
  events?.addEventListener("languagechange", languageChanged);
  events?.addEventListener("storage", storageChanged);
  runtime.dispose = () => {
    runtime.bindings.disconnect();
    events?.removeEventListener("languagechange", languageChanged);
    events?.removeEventListener("storage", storageChanged);
  };
  runtime.ready = runtime.ready.then(() => {
    if (doc?.documentElement) {
      doc.documentElement.lang = runtime.locale;
      doc.documentElement.dir = runtime.direction;
    }
    if (validPreference(stored, registry) && !readLocaleCookie(cookieOf(doc), registry)) persist(stored);
    return runtime;
  });
  return runtime;
}
/** @returns {ReturnType<typeof createI18n>} */
export function getBrowserI18n() {
  let runtime = globalThis[SLOT];
  // An older login bundle can initialize this slot before an upgraded workspace loads.
  // Validate each owner once; checking every message on every render would be wasteful.
  if (runtime && !compatibleOwners.has(runtime) && !requiredMessages.every((id) => runtime.has?.(id))) {
    runtime.dispose?.();
    runtime = null;
  }
  if (!runtime) runtime = globalThis[SLOT] = createI18n();
  compatibleOwners.add(runtime);
  messageOwners.set(runtime.t, runtime.bindings);
  // One owner shared by separately loaded entry bundles and the regression API.
  globalThis.__pandaForceI18n = runtime;
  return runtime;
}
export function localizeText(element, id, values, t = getBrowserI18n().t) {
  const bindings = messageOwners.get(t);
  if (bindings) bindings.text(element, id, values);
  else if (element) element.textContent = t(id, values);
}
export function localizeAttribute(element, name, id, values, t = getBrowserI18n().t) {
  const bindings = messageOwners.get(t);
  if (bindings) bindings.attribute(element, name, id, values);
  else element?.setAttribute(name, t(id, values));
}
export function bindMessages(root) {
  getBrowserI18n().bindings.bind(root);
}
export { LOCALE_PREFERENCE_KEY as LOCALE_STORAGE_KEY, SUPPORTED_LOCALES };

export function setMessageHtml(element, html) {
  clearMessageBinding(element, "text");
  const clean = sanitizeInterfaceHtml(html, element.ownerDocument?.defaultView);
  element.innerHTML = clean;
  if (clean.includes("data-pf-")) bindMessages(element);
  return clean;
}

export { setOpaqueAttribute, setOpaqueText } from "./bindings.js";

// Only application-owned IDs become bindings. Provider text stays opaque.
export function messageHtml(id, values = {}, t = getBrowserI18n().t) {
  return `<span data-pf-message="${escapeMessage(id)}" data-pf-values="${escapeMessage(JSON.stringify(values))}">${escapeMessage(t(id, values))}</span>`;
}

export function messageAttributes(name, id, values = {}, t = getBrowserI18n().t) {
  if (!["title", "placeholder", "aria-label", "data-tooltip"].includes(name))
    throw new Error("Unsupported message attribute");
  return `${name}="${escapeMessage(t(id, values))}" data-pf-${name}="${escapeMessage(id)}" data-pf-values="${escapeMessage(JSON.stringify(values))}"`;
}
