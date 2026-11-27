export type { ContentGrantRole as ContentAccessRole } from "../../shared/content-access.js";
import type { ContentGrantRole as ContentAccessRole } from "../../shared/content-access.js";
export type ContentAccessAction = "read" | "contribute";
export interface ContentAccessPolicy {
  mode: "restricted" | "shared";
  administrators: ReadonlySet<string>;
}
export interface ContentAccessMemberships {
  projectOwner?(project: string): string | null | Promise<string | null>;
  projectOwners?(projects: readonly string[]): Map<string, string> | Promise<Map<string, string>>;
  role(owner: string, project: string): ContentAccessRole | null | Promise<ContentAccessRole | null>;
  roles?(
    owner: string,
    projects: readonly string[],
  ): Map<string, ContentAccessRole> | Promise<Map<string, ContentAccessRole>>;
}
export class ContentAccessError extends Error {
  constructor(readonly code: "invalidInput" | "notFound" | "forbidden" | "conflict" | "unavailable") {
    super(code);
  }
}
export function contentAccessOwner(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ContentAccessError("invalidInput");
  return value;
}
export function contentAccessProject(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new ContentAccessError("invalidInput");
  return value;
}

export type LegacyProjectOwnership = { actor: string; allowUnverified: boolean };
