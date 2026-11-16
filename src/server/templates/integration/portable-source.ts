import { localizedPresentation } from "../../../shared/presentation/localized.js";
import type { PortableRegistrySnapshot } from "../../../shared/templates/portable/registry.js";
import { managedTemplateKey, type ManagedTemplate } from "../../../shared/templates/catalog.js";
import type { TemplateCatalogSource } from "../ports.js";

/** Only management capabilities are projected until each consumer implements portable-template authority. */
export function portableTemplateSource(
  read: () => PortableRegistrySnapshot | Promise<PortableRegistrySnapshot>,
): TemplateCatalogSource {
  return {
    registry: "portable",
    async read() {
      const snapshot = await read();
      const templates: ManagedTemplate[] = snapshot.templates.map((value) => {
        const manifest = value.manifest,
          reference = {
            registry: "portable" as const,
            kind: "template" as const,
            id: value.id,
            version: value.version,
            digest: value.digest,
          };
        return {
          key: managedTemplateKey(reference),
          reference,
          templateType: manifest.templateType,
          categories: [...manifest.categories],
          label: localizedPresentation(manifest.name, manifest.description),
          ...(manifest.previews.some((path) => /\.(?:png|jpe?g|webp)$/i.test(path))
            ? { artwork: { alt: manifest.name } }
            : {}),
          publisher: manifest.publisher.name,
          license: manifest.license.expression,
          origin: value.origin,
          state: {
            enabled: value.enabled,
            exportEnabled: value.enabled,
            packageEnabled: true,
            active: value.active,
            removed: false,
          },
          compatibility: { engines: [], formats: [], outputs: [] },
          actions: {
            editor:
              manifest.templateType === "panda.document-template" &&
              ["panda.document-layout/v1", "panda.rich-document-layout/v1"].includes(manifest.payload.format)
                ? "portable-document"
                : null,
            preview: "portable-template",
            export: "portable-template",
            setEnabled: true,
            activate: value.enabled && !value.active,
          },
        };
      });
      return { registry: "portable", revision: String(snapshot.revision), templates };
    },
  };
}
