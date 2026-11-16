import type { CompatibleStore } from "../packages/mysql-ledger.js";
import type { VariantRepository } from "./variant-repository.js";
import type { FileVariantRepository } from "./file-variant-repository.js";
export type VariantStore = CompatibleStore<Pick<VariantRepository, "create" | "get" | "source" | "list" | "review">> & {
  readonly asynchronous?: boolean;
  files: CompatibleStore<Pick<FileVariantRepository, "register" | "reference">>;
};
