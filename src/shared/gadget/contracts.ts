export type GadgetLocale = "en" | "zh-CN" | "zh-HK" | "zh-TW";
export type GadgetNames = Record<GadgetLocale, string>;
export type GadgetConfig = Record<string, string | number | boolean>;
export interface GadgetManifest {
  id: string;
  apiVersion: 1;
  version: string;
  configVersion: number;
  title: GadgetNames;
  description: GadgetNames;
  icon: string;
  singleton: boolean;
  source: "system" | "extension";
  layout: { w: number; h: number; minW: number; minH: number };
  defaultPlacement?: { x: number; y: number; order: number };
  config: Record<
    string,
    {
      label?: GadgetNames;
      type: "string" | "number" | "boolean";
      default: string | number | boolean;
      max?: number;
      min?: number;
    }
  >;
  permissions: readonly string[];
  services: readonly string[];
  actions: readonly string[];
  clientCapabilities?: readonly string[];
  events?: { publish: readonly string[]; subscribe: readonly string[] };
  minRefreshSeconds: number;
}
export interface GadgetInstance {
  id: string;
  gadget: string;
  configVersion: number;
  config: GadgetConfig;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: { desktop: boolean; mobile: boolean };
}
export interface GadgetLayout {
  version: 1;
  revision: number;
  density: "compact" | "comfortable";
  preset: "primary" | "equal" | "full";
  items: GadgetInstance[];
  mobileOrder: string[];
  catalogVersion?: number;
}
export class GadgetError extends Error {
  constructor(
    readonly code: "invalidInput" | "conflict" | "unavailable" | "forbidden" | "missing" | "incompatible",
    readonly status = (
      { invalidInput: 400, conflict: 409, unavailable: 503, forbidden: 403, missing: 404, incompatible: 409 } as const
    )[code],
  ) {
    super(code);
    this.name = "GadgetError";
  }
}
export const GADGET_LIMITS = { instances: 24, bytes: 128 * 1024, responseBytes: 256 * 1024, rows: 20 } as const;
export function gadgetName(names: GadgetNames, locale: string): string {
  return names[locale as GadgetLocale] || names.en;
}

/** SDK bundles have separate class identities; only stable platform code/status pairs cross the integration boundary. */
export function gadgetFailure(value: unknown): { code: GadgetError["code"]; status: number } | null {
  if (!value || typeof value !== "object") return null;
  const error = value as { name?: unknown; code?: unknown; status?: unknown };
  const statuses = {
    invalidInput: 400,
    conflict: 409,
    unavailable: 503,
    forbidden: 403,
    missing: 404,
    incompatible: 409,
  };
  if (
    error.name !== "GadgetError" ||
    typeof error.code !== "string" ||
    !Object.hasOwn(statuses, error.code) ||
    statuses[error.code as keyof typeof statuses] !== error.status
  )
    return null;
  return { code: error.code as GadgetError["code"], status: Number(error.status) };
}
