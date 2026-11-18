import type { ApplicationToolDefinition } from "../../../../shared/engine/application-tools.js";
import type { GeneratedKind, GeneratedOriginal } from "./generated-originals.js";
import type { CreationOriginalSources } from "./original-source.js";

export interface CreationArtifactGenerator {
  kind: GeneratedKind;
  definition: ApplicationToolDefinition;
  available?(): Promise<boolean>;
  mode?: string;
  render(
    value: unknown,
    context: {
      image(handle: string): Promise<Uint8Array>;
      signal: AbortSignal;
      sources: CreationOriginalSources;
      authorize(): Promise<void>;
    },
  ): Promise<GeneratedOriginal>;
}
