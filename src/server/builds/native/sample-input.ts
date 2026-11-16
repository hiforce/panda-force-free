import { BUILD_ENGINES, type BuildEngine } from "../../../shared/builds/engines.js";
import { buildInput } from "../../../shared/builds/validation.js";
import type { NativeBuildThemeRef } from "../../../shared/builds/native-samples.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { PUBLIC_STYLE_SAMPLE } from "../../../shared/presentation/sample-content.js";

export const NATIVE_SAMPLE_RUNNER = "native-site-samples/v2";
export const nativeSampleInput = (engine: BuildEngine) =>
  buildInput({
    protocol: 1,
    engine,
    preset: engine === "hexo" ? "reader" : "handbook",
    site: {
      title: PUBLIC_STYLE_SAMPLE.title,
      locale: PUBLIC_STYLE_SAMPLE.locale,
      url: "https://sample.example.test",
      basePath: "/",
    },
    documents: [
      { id: "style-sample", path: "sample.md", title: PUBLIC_STYLE_SAMPLE.title, content: PUBLIC_STYLE_SAMPLE.content },
    ],
    assets: [],
  });
export function nativeSampleKey(theme: NativeBuildThemeRef, engine: BuildEngine) {
  return contentSha256(
    JSON.stringify({
      runner: NATIVE_SAMPLE_RUNNER,
      engineVersion: BUILD_ENGINES[engine],
      theme,
      input: nativeSampleInput(engine),
    }),
  );
}
