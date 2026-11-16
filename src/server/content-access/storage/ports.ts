import type { ContentAccessRole, ContentAccessMemberships } from "../contracts.js";
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
  reserveCreator?(owner: string, project: string, now: number): Promise<void>;
}
