/** A destination edition can alias a region; changing the language or writing script needs a translation. */
export function compatibleDocumentLocale(source: string, target: string): boolean {
  try {
    const original = new Intl.Locale(source).maximize(),
      destination = new Intl.Locale(target).maximize();
    return original.language === destination.language && original.script === destination.script;
  } catch {
    return false;
  }
}
