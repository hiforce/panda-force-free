import type { AsyncStore } from "../../../shared/async-store.js";
import type { SocialTarget } from "../../../shared/delivery/social.js";
import { DeliveryError } from "../errors.js";
import type { SocialAccounts } from "./ports.js";
/** A renewed grant can change its version, never the account or project receiving the content. */
export async function mysqlCurrentBoundTarget(
  accounts: AsyncStore<SocialAccounts>,
  owner: string,
  original: SocialTarget,
): Promise<SocialTarget> {
  const current = await accounts.target(owner, original.id);
  if (
    current.id !== original.id ||
    current.projectId !== original.projectId ||
    current.accountId !== original.accountId
  )
    throw new DeliveryError("accountBindingChanged", 409);
  return current;
}
