import { officeFixture } from "./office-presentation.js";
import { NativePresentation } from "../../src/server/slides/office/package.js";
import { NativeSlidesTemplate } from "../../src/server/slides/templates/model.js";
import type { NativeSlidesSettings } from "../../src/shared/slides/templates.js";

export const nativeSlidesFixtureSettings = (version = "1.0.0"): NativeSlidesSettings => ({
  schema: 1,
  id: "example.native-slides",
  version,
  name: { en: "Native deck", "zh-CN": "原生文稿" },
  description: { en: "A private native template fixture" },
  publisher: "Fixture author",
  license: "LicenseRef-Private",
});
export async function nativeSlidesFixture(version = "1.0.0", options: { slides?: number } = {}) {
  const original = officeFixture({ kind: "potx", slides: options.slides ?? 0 }).bytes(),
    presentation = await NativePresentation.open(original, "source.potx"),
    mapping = {
      schema: "panda.powerpoint-mapping/v1" as const,
      sourceSha256: presentation.index.source.sha256,
      slots: [
        {
          id: "title",
          label: "Title",
          kind: "text" as const,
          required: true,
          target: { part: presentation.index.layouts[0]!.path, shapeId: "2" },
        },
      ],
    },
    settings = nativeSlidesFixtureSettings(version),
    license = "Copyright Fixture Author. All rights reserved.\n",
    readme = "Use the title layout.\n",
    template = await NativeSlidesTemplate.create(original, settings, mapping, license, readme);
  return { original, presentation, mapping, settings, license, readme, template };
}
