import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_LOCALE_CODES, SUPPORTED_LOCALES } from "../../src/shared/i18n/locale-policy.js";
import { auditCatalogCoverage } from "./catalog-contract.mjs";

/** Direct client builds enforce the same four-language contract as source verification. */
export function assertPublishedCatalogs() {
  const catalogs = new Map();
  for (const locale of SUPPORTED_LOCALES) {
    const directory = "src/shared/i18n/locales/" + locale.code,
      messages = {};
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".json")))
      for (const [key, text] of Object.entries(JSON.parse(readFileSync(join(directory, name), "utf8"))))
        messages[name.slice(0, -5) + "." + key] = text;
    catalogs.set(locale.code, messages);
  }
  const { failures } = auditCatalogCoverage(catalogs, REQUIRED_LOCALE_CODES);
  if (failures.length) throw new Error(failures.join("\n"));
}
