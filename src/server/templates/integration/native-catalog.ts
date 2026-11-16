import { localizedPresentation } from "../../../shared/presentation/localized.js";
import { managedTemplateKey, type ManagedTemplate } from "../../../shared/templates/catalog.js";
import type { NativeThemeSnapshot } from "../../../shared/templates/native/contracts.js";
import type { TemplateCatalogSource } from "../ports.js";

/** Private native originals are projected only for an established principal; the catalog owns no copies. */
export function nativeThemeCatalogSource(
  read: (actor: string) => NativeThemeSnapshot | Promise<NativeThemeSnapshot>,
): TemplateCatalogSource {
  return {
    registry: "native",
    async read(actor) {
      const snapshot = actor === undefined ? { revision: 0, themes: [] } : await read(actor);
      const templates: ManagedTemplate[] = snapshot.themes.map((value) => {
        const { settings, source, root } = value.descriptor,
          reference = {
            registry: "native" as const,
            kind: "site-theme" as const,
            id: value.id,
            version: value.version,
            digest: value.digest,
          };
        return {
          key: managedTemplateKey(reference),
          reference,
          templateType: "panda.site-theme",
          categories: ["publishing"],
          label: localizedPresentation(settings.name, settings.description),
          publisher: settings.publisher,
          license: settings.license.expression,
          origin: { kind: "captured", sha256: source.digest, root, source: source.origin },
          state: {
            enabled: value.enabled,
            exportEnabled: value.enabled,
            packageEnabled: true,
            active: value.active,
            removed: false,
          },
          compatibility: { engines: [settings.engine], formats: [], outputs: ["web"] },
          actions: {
            editor: null,
            preview: "site-build",
            export: "native-zip",
            setEnabled: true,
            activate: value.enabled && !value.active,
          },
        };
      });
      return { registry: "native", revision: String(snapshot.revision), templates };
    },
  };
}
