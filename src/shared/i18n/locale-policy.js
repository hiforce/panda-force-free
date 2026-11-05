export const DEFAULT_LOCALE = "en";
export const LOCALE_PREFERENCE_KEY = "panda-force-locale";
export const SUPPORTED_LOCALES = Object.freeze([
  Object.freeze({ code: "en", name: "English", direction: "ltr", formatLocale: "en" }),
  Object.freeze({ code: "zh-CN", name: "简体中文", direction: "ltr", formatLocale: "zh-CN" }),
]);

export function canonicalLocale(value) {
  try {
    return Intl.getCanonicalLocales(String(value || "").replaceAll("_", "-"))[0] || null;
  } catch {
    return null;
  }
}

export function validPreference(value, registry = SUPPORTED_LOCALES) {
  return value === "system" || registry.some((entry) => entry.code === value);
}

export function matchLocale(value, registry = SUPPORTED_LOCALES) {
  const code = canonicalLocale(value);
  if (!code) return null;
  const exact = registry.find((entry) => entry.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact.code;
  const requested = new Intl.Locale(code).maximize();
  // Script matching keeps traditional and simplified Chinese distinct without
  // hard-coding language branches into the runtime or selector.
  const candidates = registry.filter((entry) => {
    const candidate = new Intl.Locale(entry.code).maximize();
    return candidate.language === requested.language && candidate.script === requested.script;
  });
  return (
    (candidates.find((entry) => new Intl.Locale(entry.code).maximize().region === requested.region) || candidates[0])
      ?.code || null
  );
}

export function resolveLocale(preference = "system", languages = [], registry = SUPPORTED_LOCALES) {
  if (preference !== "system" && validPreference(preference, registry)) return preference;
  if (preference !== "system") return DEFAULT_LOCALE;
  for (const value of Array.isArray(languages) ? languages : [languages]) {
    const match = matchLocale(value, registry);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function parseLanguageHeader(header = "") {
  return String(header)
    .split(",")
    .map((entry, index) => {
      const [language, ...options] = entry.trim().split(";");
      const quality = options.find((option) => /^q=/i.test(option.trim()));
      return { language, index, q: quality ? Number(quality.trim().slice(2)) : 1 };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0 && entry.q <= 1 && canonicalLocale(entry.language))
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((entry) => entry.language);
}

export function readLocaleCookie(cookie = "", registry = SUPPORTED_LOCALES) {
  const part = String(cookie)
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(LOCALE_PREFERENCE_KEY + "="));
  if (!part) return null;
  try {
    const value = decodeURIComponent(part.slice(LOCALE_PREFERENCE_KEY.length + 1));
    return validPreference(value, registry) ? value : null;
  } catch {
    return null;
  }
}
