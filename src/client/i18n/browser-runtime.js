import { createI18nRuntime } from "../../shared/i18n/runtime.js";
import {
  LOCALE_PREFERENCE_KEY,
  SUPPORTED_LOCALES,
  validPreference,
  readLocaleCookie,
} from "../../shared/i18n/locale-policy.js";
import { createMessageBindings, clearMessageBinding } from "./bindings.js";

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
    readLocaleCookie(cookieOf(doc), registry) || (validPreference(stored, registry) ? stored : "system");
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
  Object.assign(runtime.t, {
    text: runtime.bindings.text,
    attribute: runtime.bindings.attribute,
    bind: runtime.bindings.bind,
  });
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
export function getBrowserI18n() {
  const runtime = (globalThis[SLOT] ||= createI18n());
  // One owner shared by separately loaded entry bundles and the regression API.
  globalThis.__pandaForceI18n = runtime;
  return runtime;
}
export function localizeText(element, id, values, t = getBrowserI18n().t) {
  if (t.text) t.text(element, id, values);
  else if (element) element.textContent = t(id, values);
}
export function localizeAttribute(element, name, id, values, t = getBrowserI18n().t) {
  if (t.attribute) t.attribute(element, name, id, values);
  else element?.setAttribute(name, t(id, values));
}
export function bindMessages(root) {
  getBrowserI18n().bindings.bind(root);
}
export { LOCALE_PREFERENCE_KEY as LOCALE_STORAGE_KEY, SUPPORTED_LOCALES };

export function setMessageHtml(element, html) {
  clearMessageBinding(element, "text");
  element.innerHTML = html;
  if (String(html).includes("data-pf-")) bindMessages(element);
  return html;
}

export { setOpaqueText, setOpaqueAttribute } from "./bindings.js";

const escapeMessage = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
// Only application-owned IDs become bindings. Provider text stays opaque.
export function messageHtml(id, values = {}, t = getBrowserI18n().t) {
  return `<span data-pf-message="${escapeMessage(id)}" data-pf-values="${escapeMessage(JSON.stringify(values))}">${escapeMessage(t(id, values))}</span>`;
}

export function messageAttributes(name, id, values = {}, t = getBrowserI18n().t) {
  if (!["title", "placeholder", "aria-label", "data-tooltip"].includes(name))
    throw new Error("Unsupported message attribute");
  return `${name}="${escapeMessage(t(id, values))}" data-pf-${name}="${escapeMessage(id)}" data-pf-values="${escapeMessage(JSON.stringify(values))}"`;
}
