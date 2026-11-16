import { localizedPresentation } from "../../../shared/presentation/localized.js";
import { managedTemplateKey, type ManagedTemplate } from "../../../shared/templates/catalog.js";
import type { NativeSlidesSnapshot } from "../../../shared/slides/registry.js";
import type { TemplateCatalogSource } from "../ports.js";

/** The common gallery projects private Office facts without owning a second registry or granting execution. */
export function nativeSlidesCatalogSource(
  read: (actor: string) => NativeSlidesSnapshot | Promise<NativeSlidesSnapshot>,
): TemplateCatalogSource {
  return {
    registry: "native-slides",
    async read(actor) {
      const snapshot = actor === undefined ? { revision: 0, templates: [] } : await read(actor);
      return {
        registry: "native-slides",
        revision: String(snapshot.revision),
        templates: snapshot.templates.map((value): ManagedTemplate => {
          const { settings } = value.descriptor.manifest,
            { importedFrom } = value.descriptor,
            selection = importedFrom.selection;
          const reference = {
            registry: "native-slides" as const,
            kind: "slides-template" as const,
            id: value.id,
            version: value.version,
            digest: value.digest,
          };
          return {
            key: managedTemplateKey(reference),
            reference,
            templateType: "panda.slides-template",
            categories: ["slides"],
            label: localizedPresentation(settings.name, settings.description),
            publisher: settings.publisher,
            license: settings.license,
            origin: {
              kind: "captured",
              sha256: importedFrom.digest,
              root: selection.kind === "archive" ? "" : selection.kind === "file" ? selection.path : selection.root,
              source: importedFrom.origin,
            },
            state: {
              enabled: value.enabled,
              exportEnabled: value.enabled,
              packageEnabled: true,
              active: value.active,
              removed: false,
            },
            compatibility: { engines: [], formats: [], outputs: ["slides"] },
            actions: {
              editor: null,
              preview: null,
              export: "native-slides-zip",
              setEnabled: true,
              activate: value.enabled && !value.active,
            },
          };
        }),
      };
    },
  };
}
