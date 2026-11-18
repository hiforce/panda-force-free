import type { CreationMaterial } from "../../shared/creation/contracts.js";
import type { ApplicationToolResult } from "../../shared/engine/application-tools.js";

export interface CreationMaterialPort {
  prepare(owner: string, refs: unknown): Promise<CreationMaterial[]>;
  read(owner: string, material: CreationMaterial, offset?: number, locale?: string): Promise<ApplicationToolResult>;
  readOriginal?(owner: string, material: CreationMaterial): Promise<Uint8Array>;
}
