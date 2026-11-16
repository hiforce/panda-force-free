import { NativeThemeError, type NativeThemeSettings } from "./contracts.js";
import {
  templateObject,
  templateId,
  templateVersion,
  templateText,
  templateLocalized,
  templateChoice,
} from "../portable/validation.js";
import { nativeThemeDefinition } from "../../builds/native-theme.js";
import { BUILD_ENGINES } from "../../builds/engines.js";
import { sourcePath } from "../../packages/sources/paths.js";
import { freezeTemplate } from "../portable/validation.js";

/** Native source metadata has its own schema, without changing portable JSON template limits. */
export function nativeThemeSettings(value: unknown): NativeThemeSettings {
  try {
    const input = templateObject(value, [
        "schema",
        "id",
        "version",
        "name",
        "description",
        "publisher",
        "license",
        "readme",
        "engine",
        "entry",
        "dependencies",
      ]),
      license = templateObject(input.license, ["expression", "file"]),
      id = templateId(input.id),
      version = templateVersion(input.version),
      engine = templateChoice(input.engine, ["hexo", "docusaurus"]),
      definition = nativeThemeDefinition(
        {
          schema: 1,
          id,
          version,
          engine,
          engineVersion: BUILD_ENGINES[engine],
          source: { digest: "0".repeat(64), projectionDigest: "0".repeat(64), root: "" },
          entry: input.entry,
          dependencies: input.dependencies,
        },
        engine,
      ),
      name = templateLocalized(input.name),
      description = templateLocalized(input.description),
      publisher = templateText(input.publisher, 160),
      expression = templateText(license.expression, 120);
    if (
      input.schema !== 1 ||
      id.length > 64 ||
      Object.values(name).some((text) => text.length > 160 || /[\r\n]/.test(text)) ||
      /[\r\n]/.test(publisher + expression)
    )
      throw new NativeThemeError("invalidInput");
    return freezeTemplate({
      schema: 1,
      id,
      version,
      name,
      description,
      publisher,
      license: { expression, file: sourcePath(license.file) },
      readme: input.readme === null ? null : sourcePath(input.readme),
      engine,
      entry: definition.entry,
      dependencies: definition.dependencies,
    });
  } catch (error) {
    if (error instanceof NativeThemeError) throw error;
    throw new NativeThemeError("invalidInput");
  }
}
