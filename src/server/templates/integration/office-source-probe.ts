import type { TemplateSourceCandidate } from "../../../shared/templates/sources/contracts.js";
import { NATIVE_SLIDES_BUNDLE_FILE, NATIVE_SLIDES_BUNDLE_SCHEMA } from "../../../shared/slides/templates.js";
import { TemplateSourceIndex, sourcePathAt, sourceRecord, sourceRootEligible } from "../sources/index.js";
import { OpcPackage } from "../../packages/opc/package.js";
import { OFFICE_CONTENT_TYPES } from "../../slides/office/namespaces.js";
import { OpcError } from "../../packages/opc/errors.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";

/** Presence and names are discovery hints; native admission verifies the full OPC package and mapping on selection. */
export function* officeSourceProbe(index: TemplateSourceIndex): Iterable<TemplateSourceCandidate> {
  const managedOriginals = new Set<string>();
  for (const file of index.entries(NATIVE_SLIDES_BUNDLE_FILE)) {
    const metadata = index.metadata(file.path, 128 * 1024);
    if (metadata?.schema !== NATIVE_SLIDES_BUNDLE_SCHEMA || !sourceRecord(metadata.settings)) continue;
    yield {
      ...index.candidate(
        "powerpoint-bundle",
        file.root,
        [file.path],
        sourceRecord(metadata.settings.name) ? metadata.settings.name.en : null,
      ),
      location: { kind: "directory", path: file.root },
    };
    if (sourceRecord(metadata.original) && ["original.pptx", "original.potx"].includes(String(metadata.original.path)))
      managedOriginals.add(sourcePathAt(file.root, String(metadata.original.path)));
  }
  const contentTypes = index.files.find((file) => file.path.toLowerCase() === "[content_types].xml");
  if (contentTypes && index.files.some((file) => file.path.toLowerCase() === "_rels/.rels")) {
    try {
      // OPC relationships choose the main part; valid presentations need not use the conventional ppt/presentation.xml path.
      const packageValue = new OpcPackage(index.source.tree);
      const main = packageValue
        .relationships(null)
        .find((relationship) => relationship.type.endsWith("/officeDocument"));
      if (
        main &&
        !main.external &&
        (packageValue.contentTypes.matches(main.part, OFFICE_CONTENT_TYPES.pptx) ||
          packageValue.contentTypes.matches(main.part, OFFICE_CONTENT_TYPES.potx))
      )
        yield {
          ...index.candidate("powerpoint-template", "", [contentTypes.path, main.part]),
          location: { kind: "archive" },
        };
    } catch (error) {
      if (!(error instanceof OpcError || error instanceof SourceError)) throw error;
      index.issues.push({ path: contentTypes.path, code: "metadataInvalid" });
    }
  }
  for (const file of index.files) {
    if (!/\.(?:pptx|potx)$/i.test(file.path) || !sourceRootEligible(file.path) || managedOriginals.has(file.path))
      continue;
    const root = file.path.split("/").slice(0, -1).join("/");
    yield {
      ...index.candidate("powerpoint-template", root, [file.path], file.path.split("/").at(-1)),
      location: { kind: "file", path: file.path },
    };
  }
}
