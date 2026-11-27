import type { ContentAccessRole, ContentAccessMemberships, LegacyProjectOwnership } from "../contracts.js";
import type { ContentAccessGrant } from "./grants.js";
type Awaitable<T> = T | Promise<T>;
export interface ContentAccessRepository extends ContentAccessMemberships {
  revision(): Awaitable<number>;
  grants(project: string): Awaitable<{ revision: number; grants: ContentAccessGrant[] }>;
  set(
    actor: string,
    project: string,
    owner: string,
    role: ContentAccessRole | null,
    revision: number,
    now: number,
  ): Awaitable<{ revision: number; grants: ContentAccessGrant[] }>;
  legacyCreator?(project: string): Awaitable<string | null>;
  reserveCreator?(owner: string, project: string, now: number, members?: readonly string[]): Awaitable<void>;
  replaceMembers?(
    owner: string,
    project: string,
    members: readonly string[],
    revision: number,
    now: number,
    legacy?: LegacyProjectOwnership,
  ): Awaitable<void>;
}
