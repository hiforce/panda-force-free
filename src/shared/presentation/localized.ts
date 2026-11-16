/** Resolve each metadata field independently; a regional tag never borrows an unrelated sibling translation. */
export function localizedText(value: Readonly<Record<string, string>>, locale = "en", fallback = "en"): string {
  const entries = new Map(Object.entries(value).map(([key, text]) => [key.toLowerCase(), text]));
  const candidates = [locale.toLowerCase()];
  try {
    const requested = new Intl.Locale(locale),
      expanded = requested.maximize();
    candidates.push(
      requested.baseName,
      `${expanded.language}-${expanded.script}-${expanded.region}`,
      `${expanded.language}-${expanded.region}`,
      `${expanded.language}-${expanded.script}`,
      expanded.language,
    );
  } catch {
    candidates.push(locale.split("-")[0]!);
  }
  for (const candidate of candidates) {
    const match = entries.get(candidate.toLowerCase());
    if (match) return match;
  }
  return entries.get(fallback.toLowerCase()) || "";
}

export function localizedPresentation(
  name: Readonly<Record<string, string>>,
  description: Readonly<Record<string, string>>,
) {
  return {
    name: name.en || "",
    description: description.en || "",
    labels: Object.fromEntries(
      [...new Set([...Object.keys(name), ...Object.keys(description)])].map((locale) => [
        locale,
        { name: localizedText(name, locale), description: localizedText(description, locale) },
      ]),
    ),
  };
}
