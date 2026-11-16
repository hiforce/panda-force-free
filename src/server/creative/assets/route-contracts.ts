import type { Route, RouteContext } from "../../http/router.js";
import type { FileCreativeAssets } from "./service.js";
import type { FileCreativeAssetReader } from "./reader.js";
import type { CreativeAsset, CreativeAssetPage } from "../../../shared/creative/assets.js";

export interface CreativeAssetRouteServices {
  owner(context: RouteContext): string;
  read(owner: string, project: string): Promise<FileCreativeAssetReader>;
  write(owner: string, project: string): Promise<FileCreativeAssets>;
  canWrite?(owner: string, project: string): boolean | Promise<boolean>;
  capabilities?(owner: string, project: string): Promise<{ contribute: boolean; originals?: boolean }>;
  list?(owner: string, project: string, cursor?: string, state?: CreativeAsset["state"]): Promise<CreativeAssetPage>;
}
export type CreativeAssetRouteProtection = (
  handler: (context: RouteContext, signal: AbortSignal) => unknown | Promise<unknown>,
  heavy?: boolean,
) => Route["handler"];
