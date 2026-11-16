import { messageContract } from "../../src/shared/i18n/message-contract.js";

/** Published packs are complete artifacts; runtime fallback does not excuse missing translations. */
export function auditCatalogCoverage(catalogs, required) {
  const failures = [],
    contracts = new Map();
  for (const locale of required) if (!catalogs.has(locale)) failures.push("Required locale is missing: " + locale);
  for (const [locale, messages] of catalogs) {
    const parsed = {};
    for (const [id, text] of Object.entries(messages)) {
      try {
        if (typeof text !== "string" || !text.trim()) throw new Error("Translation must not be empty");
        parsed[id] = { text, contract: messageContract(text) };
      } catch (error) {
        failures.push(locale + ": " + id + ": " + error.message);
      }
    }
    contracts.set(locale, parsed);
  }
  const english = contracts.get("en") || {};
  for (const [locale, messages] of contracts) {
    for (const id of Object.keys(english)) {
      if (!messages[id]) failures.push(locale + ": missing " + id);
      else if (JSON.stringify(messages[id].contract) !== JSON.stringify(english[id].contract))
        failures.push(locale + ": parameter contract differs for " + id);
    }
    for (const id of Object.keys(messages)) if (!english[id]) failures.push(locale + ": unknown key " + id);
  }
  return { failures, contracts };
}
