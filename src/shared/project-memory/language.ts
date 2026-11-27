export const defaultMemoryLanguage = "en";
export const memoryPreferencesPath = "/api/personal/harness/memory-preferences";

const languages =
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu";
const regionalLanguages = [
  "ar-EG",
  "ar-SA",
  "bn-BD",
  "bs-Cyrl",
  "ckb",
  "de-AT",
  "de-CH",
  "en-AU",
  "en-GB",
  "en-IN",
  "en-US",
  "es-419",
  "es-AR",
  "es-ES",
  "es-MX",
  "fil",
  "fr-CA",
  "fr-CH",
  "gsw",
  "haw",
  "ko-KR",
  "ms-MY",
  "nb-NO",
  "nn-NO",
  "pt-BR",
  "pt-PT",
  "sr-Cyrl",
  "sr-Latn",
  "uz-Cyrl",
  "uz-Latn",
  "yue",
  "yue-Hant-HK",
  "zh-CN",
  "zh-HK",
  "zh-Hans",
  "zh-Hant",
  "zh-TW",
];

const englishLanguageNames = new Intl.DisplayNames("en", { type: "language", fallback: "none" });
export const memoryLanguageChoices = [...languages.split(" "), ...regionalLanguages];

export function memoryLanguage(value: unknown) {
  if (typeof value !== "string" || value.length > 35 || !/^[A-Za-z0-9-]+$/u.test(value)) return null;
  try {
    const locale = new Intl.Locale(value);
    if (locale.language === "und" || !englishLanguageNames.of(locale.language)) return null;
    const tag = locale.baseName;
    return tag === locale.toString() ? tag : null;
  } catch {
    return null;
  }
}

export function memoryLanguageLabel(tag: string) {
  return englishLanguageNames.of(tag) ?? tag;
}

export function memoryDisplayName(key: string) {
  if (!/^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/u.test(key)) return key;
  return key
    .replace(/^user[-_.](?=\w)/iu, "")
    .replace(/[-_.]/gu, " ")
    .replace(/^[a-z]/u, (letter) => letter.toUpperCase());
}
