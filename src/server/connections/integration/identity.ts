import { createHash } from "node:crypto";
import type { AuthState } from "../../auth/state.js";
import type { RouteContext } from "../../http/router.js";
import { isRecord } from "../../../shared/records.js";
import { ConnectionError } from "../errors.js";
import { localRequestIdentity } from "../../auth/users/identity.js";
import { localAdministratorIdentity } from "../../auth/users/service.js";

/** Call only after PandaForce authentication; engine account identities never participate. */
export function publicationOwner(
  auth: Pick<AuthState, "administrator">,
  context: Pick<RouteContext, "idaasSession"> & Partial<Pick<RouteContext, "req">>,
): string {
  const principal = localRequestIdentity(context.req);
  if (!context.idaasSession && principal) return principal.owner;
  const identity = context.idaasSession?.identity;
  let key: unknown[];
  if (
    isRecord(identity) &&
    typeof identity.uuid === "string" &&
    identity.uuid &&
    typeof identity.tenantId === "string" &&
    identity.tenantId
  )
    key = ["idaas", identity.tenantId, identity.uuid];
  else if (!context.idaasSession && auth.administrator) return localAdministratorIdentity(auth)!.owner;
  else throw new ConnectionError("identityRequired", 403);
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}
