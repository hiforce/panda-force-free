import { readLocaleCookie, parseLanguageHeader, resolveLocale } from "../../shared/i18n/locale-policy.js";
export function requestLocale(req) {
  return resolveLocale(
    readLocaleCookie(req.headers.cookie) || "system",
    parseLanguageHeader(req.headers["accept-language"]),
  );
}
