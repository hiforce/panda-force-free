import type {
  PortableRegistrySnapshot,
  InstalledPortableTemplate,
  PortableInstallReceipt,
  PortableTemplateOrigin,
} from "../../../shared/templates/portable/registry.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
export type PortableTemplateResourceValidation = (template: VerifiedPortableTemplate) => Promise<void>;

export interface PortableTemplateContent {
  put(value: VerifiedPortableTemplate): Promise<void>;
  read(digest: string): Promise<VerifiedPortableTemplate>;
}
export interface PortableRegistryMutation {
  operationId: string;
  actor: string;
  expectedRevision: number;
  request: string;
  now: number;
}
export interface PortableRegistryStore {
  snapshot(): PortableRegistrySnapshot;
  detail(id: string, version: string): { revision: number; template: InstalledPortableTemplate };
  replay(actor: string, operationId: string, request: string): PortableInstallReceipt | null;
  operation(actor: string, operationId: string): { request: string; receipt: PortableInstallReceipt } | null;
  install(
    templates: readonly VerifiedPortableTemplate[],
    origin: PortableTemplateOrigin,
    mutation: PortableRegistryMutation,
  ): PortableInstallReceipt;
  state(
    id: string,
    version: string,
    action: "enable" | "disable" | "activate",
    actor: string,
    expectedRevision: number,
    now: number,
  ): InstalledPortableTemplate;
}
